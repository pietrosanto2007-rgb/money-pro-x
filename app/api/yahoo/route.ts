import { NextRequest, NextResponse } from "next/server";

const BASE = "https://query1.finance.yahoo.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchJson(url: string) {
  const resp = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const text = await resp.text();
  try {
    return { data: JSON.parse(text), status: resp.status };
  } catch {
    return { data: null, status: resp.status };
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint) {
    return NextResponse.json({ error: "endpoint obbligatorio" }, { status: 400 });
  }

  if (endpoint === "search") {
    const q = (searchParams.get("q") || "").trim();
    if (!q) {
      return NextResponse.json({ error: "q obbligatorio" }, { status: 400 });
    }
    const quotesCount = searchParams.get("quotesCount") || "10";
    const newsCount = searchParams.get("newsCount") || "0";
    const enableFuzzyQuery = searchParams.get("enableFuzzyQuery") || "false";
    const url = `${BASE}/v1/finance/search?q=${encodeURIComponent(
      q
    )}&quotesCount=${quotesCount}&newsCount=${newsCount}&enableFuzzyQuery=${enableFuzzyQuery}`;
    try {
      const { data, status } = await fetchJson(url);
      if (!data) {
        return NextResponse.json(
          { error: "Risposta non valida da Yahoo" },
          { status: 502 }
        );
      }
      return NextResponse.json(data, { status });
    } catch {
      return NextResponse.json(
        { error: "Errore connessione Yahoo Finance" },
        { status: 502 }
      );
    }
  }

  if (endpoint === "quote") {
    const symbolsParam = (searchParams.get("symbols") || "").trim();
    if (!symbolsParam) {
      return NextResponse.json({ error: "symbols obbligatorio" }, { status: 400 });
    }
    const symbols = symbolsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!symbols.length) {
      return NextResponse.json({ error: "symbols obbligatorio" }, { status: 400 });
    }

    // v7/quote è spesso bloccato; v8/chart funziona
    const results: Array<Record<string, unknown>> = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < symbols.length; i += CONCURRENCY) {
      const batch = symbols.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (symbol) => {
        const url = `${BASE}/v8/finance/chart/${encodeURIComponent(
          symbol
        )}?interval=1d&range=1d`;
        const { data } = await fetchJson(url);
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta || meta.regularMarketPrice == null) return null;
        return {
          symbol: String(meta.symbol || symbol).toUpperCase(),
          shortName: meta.shortName || meta.longName || symbol,
          longName: meta.longName || meta.shortName || symbol,
          currency: meta.currency || "",
          regularMarketPrice: Number(meta.regularMarketPrice),
          regularMarketPreviousClose:
            meta.chartPreviousClose != null
              ? Number(meta.chartPreviousClose)
              : undefined,
        };
      });
      const batchResults = await Promise.all(promises);
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    return NextResponse.json({ quoteResponse: { result: results } });
  }

  return NextResponse.json({ error: "endpoint non valido" }, { status: 400 });
}
