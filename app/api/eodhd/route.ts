import { NextRequest, NextResponse } from "next/server";

const BASE = "https://eodhd.com/api";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get("endpoint");
  const apiToken = searchParams.get("api_token");

  if (!endpoint || !apiToken) {
    return NextResponse.json(
      { status: "error", message: "endpoint e api_token obbligatori" },
      { status: 400 }
    );
  }

  const allowed = ["search", "real-time"];
  if (!allowed.includes(endpoint)) {
    return NextResponse.json(
      { status: "error", message: "endpoint non valido" },
      { status: 400 }
    );
  }

  let url: string;
  if (endpoint === "search") {
    const q = searchParams.get("q") || "";
    if (!q.trim()) {
      return NextResponse.json(
        { status: "error", message: "q obbligatorio" },
        { status: 400 }
      );
    }
    url = `${BASE}/search/${encodeURIComponent(q)}?api_token=${encodeURIComponent(
      apiToken
    )}&fmt=json`;
  } else {
    const symbol = searchParams.get("symbol") || "";
    if (!symbol.trim()) {
      return NextResponse.json(
        { status: "error", message: "symbol obbligatorio" },
        { status: 400 }
      );
    }
    url = `${BASE}/real-time/${encodeURIComponent(
      symbol
    )}?api_token=${encodeURIComponent(apiToken)}&fmt=json`;
  }

  try {
    const resp = await fetch(url, { cache: "no-store" });
    const text = await resp.text();
    // EODHD returns JSON, but keep this robust.
    try {
      const data = JSON.parse(text);
      return NextResponse.json(data, { status: resp.status });
    } catch {
      return new NextResponse(text, { status: resp.status });
    }
  } catch {
    return NextResponse.json(
      { status: "error", message: "Errore connessione EOD Historical Data" },
      { status: 502 }
    );
  }
}

