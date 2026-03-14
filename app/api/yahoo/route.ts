import { NextRequest, NextResponse } from "next/server";

const BASE = "https://query1.finance.yahoo.com";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint) {
    return NextResponse.json(
      { error: "endpoint obbligatorio" },
      { status: 400 }
    );
  }

  let url: string;

  if (endpoint === "search") {
    const q = (searchParams.get("q") || "").trim();
    if (!q) {
      return NextResponse.json({ error: "q obbligatorio" }, { status: 400 });
    }
    const quotesCount = searchParams.get("quotesCount") || "10";
    const newsCount = searchParams.get("newsCount") || "0";
    const enableFuzzyQuery = searchParams.get("enableFuzzyQuery") || "false";
    url = `${BASE}/v1/finance/search?q=${encodeURIComponent(
      q
    )}&quotesCount=${encodeURIComponent(
      quotesCount
    )}&newsCount=${encodeURIComponent(
      newsCount
    )}&enableFuzzyQuery=${encodeURIComponent(enableFuzzyQuery)}`;
  } else if (endpoint === "quote") {
    const symbols = (searchParams.get("symbols") || "").trim();
    if (!symbols) {
      return NextResponse.json(
        { error: "symbols obbligatorio" },
        { status: 400 }
      );
    }
    url = `${BASE}/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
  } else {
    return NextResponse.json({ error: "endpoint non valido" }, { status: 400 });
  }

  try {
    const resp = await fetch(url, {
      cache: "no-store",
      headers: {
        // Helps avoid some upstream blocks that depend on UA.
        "User-Agent":
          "MoneyProX/1.0 (+https://money-pro-x.vercel.app) Next.js proxy",
        Accept: "application/json,text/plain,*/*",
      },
    });

    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return NextResponse.json(data, { status: resp.status });
    } catch {
      return new NextResponse(text, { status: resp.status });
    }
  } catch {
    return NextResponse.json(
      { error: "Errore connessione Yahoo Finance" },
      { status: 502 }
    );
  }
}

