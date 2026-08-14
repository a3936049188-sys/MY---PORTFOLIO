"""
Market Sentiment Model

Inputs:
1. CNN Fear & Greed Index, 0-100, higher is more bullish
2. VIX Index, normalized inversely to a 0-100 sentiment score
3. S&P 500 price trend, based on moving averages and distance from 52-week high

Composite:
Market_Sentiment = 40% FearGreed + 30% VIXScore + 30% SPTrendScore

Example:
    python market_sentiment_model.py --fear-greed 52 --vix 18.7

Alpha Vantage example:
    $env:ALPHA_VANTAGE_API_KEY="your_api_key"
    python market_sentiment_model.py --fear-greed 52 --data-source alpha

.env example:
    ALPHA_VANTAGE_API_KEY=your_api_key

Historical example with a manual input CSV:
    python market_sentiment_model.py --sentiment-csv sentiment_inputs.csv

The CSV should contain:
    Date,FearGreed,VIX
    2024-01-02,55,13.4
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
import pandas as pd


REGIME_BINS = [0, 20, 40, 60, 80, 100]
REGIME_LABELS = ["Panic", "Fear", "Neutral", "Optimistic", "Euphoria"]
ENV_FILE = ".env"


@dataclass(frozen=True)
class SentimentConfig:
    sp500_ticker: str = "^GSPC"
    vix_ticker: str = "^VIX"
    alpha_sp500_symbol: str = "SPX"
    alpha_vix_symbol: str = "VIX"
    alpha_base_url: str = "https://www.alphavantage.co/query"
    start: str = "2010-01-01"
    end: str | None = None
    vix_floor: float = 10.0
    vix_ceiling: float = 80.0
    ma_short_window: int = 50
    ma_long_window: int = 200
    high_window: int = 252
    trend_short_weight: float = 0.40
    trend_long_weight: float = 0.40
    trend_high_weight: float = 0.20
    composite_fear_greed_weight: float = 0.40
    composite_vix_weight: float = 0.30
    composite_sp_trend_weight: float = 0.30


def clip_score(value: pd.Series | float | np.ndarray) -> pd.Series | float | np.ndarray:
    """Clamp a score to the required 0-100 range."""
    return np.clip(value, 0.0, 100.0)


def classify_regime(score: pd.Series | float) -> pd.Series | str:
    """
    Convert a 0-100 sentiment score into a regime label.

    Intervals:
    0-20 Panic, 20-40 Fear, 40-60 Neutral, 60-80 Optimistic, 80-100 Euphoria.
    """
    if isinstance(score, pd.Series):
        clipped = clip_score(score.astype(float))
        return pd.cut(
            clipped,
            bins=REGIME_BINS,
            labels=REGIME_LABELS,
            include_lowest=True,
            right=True,
        ).astype("string")

    score_float = float(clip_score(score))
    if score_float <= 20:
        return "Panic"
    if score_float <= 40:
        return "Fear"
    if score_float <= 60:
        return "Neutral"
    if score_float <= 80:
        return "Optimistic"
    return "Euphoria"


def fear_greed_score(fear_greed: pd.Series | float) -> pd.Series | float:
    """
    Fear & Greed is already a 0-100 sentiment measure.

    Higher values indicate more bullish sentiment.
    """
    return clip_score(fear_greed)


def vix_score(
    vix: pd.Series | float,
    floor: float = 10.0,
    ceiling: float = 80.0,
) -> pd.Series | float:
    """
    Normalize VIX into a 0-100 inverse sentiment score.

    A low VIX maps to high sentiment. A high VIX maps to low sentiment.
    The default 10-80 range uses a broad historical stress range so isolated
    volatility spikes do not distort the scale.
    """
    if ceiling <= floor:
        raise ValueError("VIX ceiling must be greater than VIX floor.")

    score = 100.0 * (ceiling - vix) / (ceiling - floor)
    return clip_score(score)


def _price_vs_average_score(
    price: pd.Series,
    moving_average: pd.Series,
    full_score_band: float,
) -> pd.Series:
    """
    Convert price distance from a moving average to a bounded 0-100 score.

    full_score_band=0.10 means:
    -10% or worse below average -> 0
    equal to average -> 50
    +10% or better above average -> 100
    """
    distance = (price / moving_average) - 1.0
    score = 50.0 + (distance / full_score_band) * 50.0
    return pd.Series(clip_score(score), index=price.index)


def sp500_trend_score(
    sp500: pd.DataFrame,
    config: SentimentConfig = SentimentConfig(),
) -> pd.DataFrame:
    """
    Build the S&P 500 trend score from:
    - price vs 50-day moving average
    - price vs 200-day moving average
    - distance from 52-week high

    Returns the input dataframe with trend components and SPTrendScore added.
    """
    if "Close" not in sp500.columns:
        raise ValueError("S&P 500 dataframe must contain a 'Close' column.")

    df = sp500.copy()
    close = df["Close"].astype(float)

    df["SMA50"] = close.rolling(config.ma_short_window, min_periods=config.ma_short_window).mean()
    df["SMA200"] = close.rolling(config.ma_long_window, min_periods=config.ma_long_window).mean()
    df["High52W"] = close.rolling(config.high_window, min_periods=config.high_window).max()

    df["Trend50Score"] = _price_vs_average_score(close, df["SMA50"], full_score_band=0.10)
    df["Trend200Score"] = _price_vs_average_score(close, df["SMA200"], full_score_band=0.20)

    distance_from_high = (close / df["High52W"]) - 1.0
    df["High52WScore"] = pd.Series(
        clip_score(100.0 + (distance_from_high / 0.20) * 100.0),
        index=df.index,
    )

    df["SPTrendScore"] = (
        config.trend_short_weight * df["Trend50Score"]
        + config.trend_long_weight * df["Trend200Score"]
        + config.trend_high_weight * df["High52WScore"]
    )
    df["SPTrendScore"] = clip_score(df["SPTrendScore"])
    return df


def composite_sentiment_score(
    fear_greed: pd.Series | float,
    vix: pd.Series | float,
    sp_trend: pd.Series | float,
    config: SentimentConfig = SentimentConfig(),
) -> pd.Series | float:
    """Calculate the weighted 0-100 Market Sentiment score."""
    score = (
        config.composite_fear_greed_weight * fear_greed_score(fear_greed)
        + config.composite_vix_weight * vix_score(vix, config.vix_floor, config.vix_ceiling)
        + config.composite_sp_trend_weight * sp_trend
    )
    return clip_score(score)


def load_env_file(path: str | Path = ENV_FILE) -> None:
    """
    Load simple KEY=VALUE pairs from a local .env file.

    Existing environment variables win, so a shell-provided API key will not be
    overwritten. This intentionally avoids an extra python-dotenv dependency.
    """
    env_path = Path(path)
    if not env_path.exists():
        return
    if env_path.is_dir():
        raise IsADirectoryError(
            f"{env_path} is a directory. Delete that folder and create a text file named {env_path}."
        )

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _filter_date_range(df: pd.DataFrame, config: SentimentConfig) -> pd.DataFrame:
    """Apply the configured start/end date filters to a DateTime-indexed dataframe."""
    result = df.copy()
    if config.start:
        result = result.loc[result.index >= pd.Timestamp(config.start)]
    if config.end:
        result = result.loc[result.index < pd.Timestamp(config.end)]
    return result


def _download_alpha_index_data(
    symbol: str,
    api_key: str,
    config: SentimentConfig = SentimentConfig(),
    interval: str = "daily",
) -> pd.DataFrame:
    """
    Download index OHLC data from Alpha Vantage INDEX_DATA.

    Alpha Vantage can return API notes for rate limits or error messages for
    unsupported symbols, so this parser validates the response before building
    a dataframe.
    """
    query = urlencode(
        {
            "function": "INDEX_DATA",
            "symbol": symbol,
            "interval": interval,
            "apikey": api_key,
        }
    )
    url = f"{config.alpha_base_url}?{query}"

    with urlopen(url, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if "Error Message" in payload:
        raise RuntimeError(f"Alpha Vantage error for {symbol}: {payload['Error Message']}")
    if "Information" in payload:
        raise RuntimeError(f"Alpha Vantage information for {symbol}: {payload['Information']}")
    if "Note" in payload:
        raise RuntimeError(f"Alpha Vantage rate limit note for {symbol}: {payload['Note']}")

    raw_rows = payload.get("data")
    if not isinstance(raw_rows, list) or not raw_rows:
        raise RuntimeError(f"Alpha Vantage returned no INDEX_DATA rows for {symbol}.")

    df = pd.DataFrame(raw_rows)
    if "timestamp" not in df.columns or "close" not in df.columns:
        raise RuntimeError(f"Unexpected Alpha Vantage INDEX_DATA schema for {symbol}: {list(df.columns)}")

    rename_map = {
        "open": "Open",
        "high": "High",
        "low": "Low",
        "close": "Close",
        "volume": "Volume",
    }
    df = df.rename(columns=rename_map)
    df["Date"] = pd.to_datetime(df["timestamp"])
    df = df.set_index("Date").sort_index()

    for column in ["Open", "High", "Low", "Close", "Volume"]:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")

    keep_columns = [column for column in ["Open", "High", "Low", "Close", "Volume"] if column in df.columns]
    return _filter_date_range(df[keep_columns].dropna(subset=["Close"]), config)


def _download_yfinance_data(
    ticker: str,
    config: SentimentConfig = SentimentConfig(),
) -> pd.DataFrame:
    """Download daily market data from Yahoo Finance."""
    try:
        import yfinance as yf
    except ImportError as exc:
        raise ImportError(
            "Missing dependency: yfinance. Install dependencies with "
            "`pip install -r requirements-market-sentiment.txt`."
        ) from exc

    df = yf.download(
        ticker,
        start=config.start,
        end=config.end,
        auto_adjust=True,
        progress=False,
    )

    if df.empty:
        raise RuntimeError(f"No data was downloaded for {ticker}. Check network access or ticker settings.")

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df.index = pd.to_datetime(df.index)
    return df


def download_market_data(
    market: str,
    config: SentimentConfig = SentimentConfig(),
    data_source: str = "auto",
    alpha_api_key: str | None = None,
) -> pd.DataFrame:
    """
    Download S&P 500 or VIX market data from Alpha Vantage and/or yfinance.

    data_source:
    - auto: try Alpha Vantage first when an API key is available, then yfinance
    - alpha: use Alpha Vantage only
    - yfinance: use yfinance only
    """
    if market not in {"sp500", "vix"}:
        raise ValueError("market must be either 'sp500' or 'vix'.")
    if data_source not in {"auto", "alpha", "yfinance"}:
        raise ValueError("data_source must be 'auto', 'alpha', or 'yfinance'.")

    alpha_symbol = config.alpha_sp500_symbol if market == "sp500" else config.alpha_vix_symbol
    yahoo_ticker = config.sp500_ticker if market == "sp500" else config.vix_ticker
    api_key = alpha_api_key or os.getenv("ALPHA_VANTAGE_API_KEY")

    errors: list[str] = []
    if data_source in {"auto", "alpha"}:
        if api_key:
            try:
                return _download_alpha_index_data(alpha_symbol, api_key, config)
            except Exception as exc:
                errors.append(f"Alpha Vantage failed for {market}: {exc}")
                if data_source == "alpha":
                    raise
        elif data_source == "alpha":
            raise ValueError(
                "Alpha Vantage API key is required. Set ALPHA_VANTAGE_API_KEY "
                "or pass --alpha-api-key."
            )

    if data_source in {"auto", "yfinance"}:
        try:
            return _download_yfinance_data(yahoo_ticker, config)
        except Exception as exc:
            errors.append(f"yfinance failed for {market}: {exc}")
            raise RuntimeError("; ".join(errors)) from exc

    raise RuntimeError("; ".join(errors) or f"Unable to download {market} data.")


def download_sp500_data(
    config: SentimentConfig = SentimentConfig(),
    data_source: str = "auto",
    alpha_api_key: str | None = None,
) -> pd.DataFrame:
    """Download daily S&P 500 data."""
    return download_market_data("sp500", config, data_source, alpha_api_key)


def download_vix_data(
    config: SentimentConfig = SentimentConfig(),
    data_source: str = "auto",
    alpha_api_key: str | None = None,
) -> pd.DataFrame:
    """Download daily VIX data."""
    return download_market_data("vix", config, data_source, alpha_api_key)


def load_manual_sentiment_csv(path: str | Path) -> pd.DataFrame:
    """
    Load historical manual Fear & Greed and VIX inputs.

    Required columns: Date, FearGreed, VIX
    """
    df = pd.read_csv(path, parse_dates=["Date"])
    required_columns = {"Date", "FearGreed", "VIX"}
    missing = required_columns.difference(df.columns)
    if missing:
        raise ValueError(f"Missing required CSV columns: {sorted(missing)}")

    df = df[["Date", "FearGreed", "VIX"]].copy()
    df = df.sort_values("Date").set_index("Date")
    df["FearGreed"] = pd.to_numeric(df["FearGreed"], errors="coerce")
    df["VIX"] = pd.to_numeric(df["VIX"], errors="coerce")
    return df


def build_sentiment_dataframe(
    fear_greed: float | None = None,
    vix: float | None = None,
    sentiment_inputs: pd.DataFrame | None = None,
    config: SentimentConfig = SentimentConfig(),
    data_source: str = "auto",
    alpha_api_key: str | None = None,
) -> pd.DataFrame:
    """
    Build a clean daily dataframe with all component scores and final regime.

    Provide scalar fear_greed, and either scalar vix, downloaded VIX data, or a
    Date-indexed dataframe with FearGreed and VIX columns.
    """
    if sentiment_inputs is None and fear_greed is None:
        raise ValueError("Provide either sentiment_inputs or --fear-greed.")

    sp500 = sp500_trend_score(download_sp500_data(config, data_source, alpha_api_key), config)
    df = sp500[["Close", "SMA50", "SMA200", "High52W", "Trend50Score", "Trend200Score", "High52WScore", "SPTrendScore"]].copy()

    if sentiment_inputs is not None:
        inputs = sentiment_inputs[["FearGreed", "VIX"]].copy()
        df = df.join(inputs, how="left")
        df[["FearGreed", "VIX"]] = df[["FearGreed", "VIX"]].ffill()
    else:
        df["FearGreed"] = float(fear_greed)
        if vix is not None:
            df["VIX"] = float(vix)
        else:
            vix_data = download_vix_data(config, data_source, alpha_api_key)
            vix_series = vix_data[["Close"]].rename(columns={"Close": "VIX"})
            df = df.join(vix_series, how="left")
            df["VIX"] = df["VIX"].ffill()

    df["FearGreedScore"] = fear_greed_score(df["FearGreed"])
    df["VIXScore"] = vix_score(df["VIX"], config.vix_floor, config.vix_ceiling)
    df["MarketSentiment"] = composite_sentiment_score(
        df["FearGreedScore"],
        df["VIX"],
        df["SPTrendScore"],
        config,
    )
    df["Regime"] = classify_regime(df["MarketSentiment"])

    ordered_columns = [
        "Close",
        "FearGreed",
        "VIX",
        "FearGreedScore",
        "VIXScore",
        "SMA50",
        "SMA200",
        "High52W",
        "Trend50Score",
        "Trend200Score",
        "High52WScore",
        "SPTrendScore",
        "MarketSentiment",
        "Regime",
    ]
    return df[ordered_columns].dropna().copy()


def add_forward_returns(
    df: pd.DataFrame,
    horizons: Iterable[int] = (5, 21, 63),
) -> pd.DataFrame:
    """Add forward S&P 500 returns for the requested trading-day horizons."""
    result = df.copy()
    for horizon in horizons:
        result[f"ForwardReturn_{horizon}D"] = result["Close"].shift(-horizon) / result["Close"] - 1.0
    return result


def backtest_extreme_sentiment(df: pd.DataFrame) -> pd.DataFrame:
    """
    Test whether extreme sentiment predicts future S&P 500 returns.

    Extreme definitions:
    - MarketSentiment < 20: Panic
    - MarketSentiment > 80: Euphoria

    Horizons:
    - 1 week: 5 trading days
    - 1 month: 21 trading days
    - 3 months: 63 trading days
    """
    horizons = {
        "1W": 5,
        "1M": 21,
        "3M": 63,
    }
    with_returns = add_forward_returns(df, horizons.values())

    groups = {
        "Panic_LT_20": with_returns["MarketSentiment"] < 20,
        "Euphoria_GT_80": with_returns["MarketSentiment"] > 80,
        "All_Days": with_returns["MarketSentiment"].notna(),
    }

    rows: list[dict[str, float | int | str]] = []
    for group_name, mask in groups.items():
        sample = with_returns.loc[mask].copy()
        for label, days in horizons.items():
            col = f"ForwardReturn_{days}D"
            returns = sample[col].dropna()
            rows.append(
                {
                    "Group": group_name,
                    "Horizon": label,
                    "Observations": int(returns.shape[0]),
                    "AverageReturn": float(returns.mean()) if not returns.empty else np.nan,
                    "MedianReturn": float(returns.median()) if not returns.empty else np.nan,
                    "WinRate": float((returns > 0).mean()) if not returns.empty else np.nan,
                    "WorstReturn": float(returns.min()) if not returns.empty else np.nan,
                    "BestReturn": float(returns.max()) if not returns.empty else np.nan,
                }
            )

    return pd.DataFrame(rows)


def plot_sentiment(
    df: pd.DataFrame,
    output_path: str | Path = "market_sentiment_score.png",
    show: bool = False,
) -> Path:
    """Plot the final Market Sentiment score through time."""
    import matplotlib.pyplot as plt

    output_path = Path(output_path)
    fig, ax = plt.subplots(figsize=(12, 6))

    df["MarketSentiment"].plot(ax=ax, color="#1f77b4", linewidth=1.4)
    ax.axhspan(0, 20, color="#d62728", alpha=0.12, label="Panic")
    ax.axhspan(20, 40, color="#ff7f0e", alpha=0.10, label="Fear")
    ax.axhspan(40, 60, color="#7f7f7f", alpha=0.08, label="Neutral")
    ax.axhspan(60, 80, color="#2ca02c", alpha=0.10, label="Optimistic")
    ax.axhspan(80, 100, color="#9467bd", alpha=0.10, label="Euphoria")

    ax.set_title("Market Sentiment Score")
    ax.set_ylabel("Score, 0-100")
    ax.set_xlabel("Date")
    ax.set_ylim(0, 100)
    ax.grid(True, alpha=0.25)
    ax.legend(loc="upper left", ncol=5, fontsize=8)
    fig.tight_layout()
    fig.savefig(output_path, dpi=150)

    if show:
        plt.show()
    else:
        plt.close(fig)

    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a 0-100 market sentiment score.")
    parser.add_argument("--fear-greed", type=float, help="Manual CNN Fear & Greed Index value, 0-100.")
    parser.add_argument("--vix", type=float, help="Manual VIX Index value. If omitted, VIX is downloaded.")
    parser.add_argument("--sentiment-csv", type=str, help="CSV with Date,FearGreed,VIX for historical scoring.")
    parser.add_argument(
        "--data-source",
        choices=["auto", "alpha", "yfinance"],
        default="auto",
        help="Market data source. auto tries Alpha Vantage first when an API key exists, then yfinance.",
    )
    parser.add_argument(
        "--alpha-api-key",
        type=str,
        default=None,
        help="Alpha Vantage API key. Prefer ALPHA_VANTAGE_API_KEY environment variable.",
    )
    parser.add_argument("--alpha-sp500-symbol", type=str, default="SPX", help="Alpha Vantage S&P 500 index symbol.")
    parser.add_argument("--alpha-vix-symbol", type=str, default="VIX", help="Alpha Vantage VIX index symbol.")
    parser.add_argument("--start", type=str, default="2010-01-01", help="S&P 500 download start date.")
    parser.add_argument("--end", type=str, default=None, help="S&P 500 download end date.")
    parser.add_argument("--output-csv", type=str, default="market_sentiment_output.csv")
    parser.add_argument("--plot-path", type=str, default="market_sentiment_score.png")
    parser.add_argument("--show-plot", action="store_true")
    return parser.parse_args()


def main() -> None:
    load_env_file()
    args = parse_args()
    config = SentimentConfig(
        start=args.start,
        end=args.end,
        alpha_sp500_symbol=args.alpha_sp500_symbol,
        alpha_vix_symbol=args.alpha_vix_symbol,
    )

    sentiment_inputs = load_manual_sentiment_csv(args.sentiment_csv) if args.sentiment_csv else None
    df = build_sentiment_dataframe(
        fear_greed=args.fear_greed,
        vix=args.vix,
        sentiment_inputs=sentiment_inputs,
        config=config,
        data_source=args.data_source,
        alpha_api_key=args.alpha_api_key,
    )

    backtest = backtest_extreme_sentiment(df)
    plot_path = plot_sentiment(df, args.plot_path, show=args.show_plot)

    df.to_csv(args.output_csv, index=True)

    latest = df.iloc[-1]
    print("\nLatest Market Sentiment")
    print("-----------------------")
    print(f"Date: {df.index[-1].date()}")
    print(f"Score: {latest['MarketSentiment']:.2f}")
    print(f"Regime: {latest['Regime']}")
    print(f"Output CSV: {Path(args.output_csv).resolve()}")
    print(f"Plot: {plot_path.resolve()}")

    print("\nExtreme Sentiment Backtest")
    print("--------------------------")
    print(backtest.to_string(index=False, float_format=lambda x: f"{x:0.4f}"))


if __name__ == "__main__":
    main()
