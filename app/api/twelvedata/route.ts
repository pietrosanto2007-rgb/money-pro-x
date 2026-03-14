import { NextRequest, NextResponse } from "next/server";

const BASE = "https://api.twelvedata.com";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get("endpoint");
  const apikey = searchParams.get("apikey");

  if (!endpoint || !apikey) {
    return NextResponse.json(
      { error: "endpoint e apikey obbligatori" },
      { status: 400 }
    );
  }

  const allowed = ["symbol_search", "quote", "logo"];
  if (!allowed.includes(endpoint)) {
    return NextResponse.json({ error: "endpoint non valido" }, { status: 400 });
  }

  const qs = new URLSearchParams();
  searchParams.forEach((v, k) => {
    if (k !== "endpoint") qs.set(k, v);
  });

  const url = `${BASE}/${endpoint}?${qs.toString()}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json(
      { error: "Errore connessione Twelve Data" },
      { status: 502 }
    );
  }
}
