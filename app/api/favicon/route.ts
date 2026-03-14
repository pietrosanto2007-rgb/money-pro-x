import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import * as cheerio from "cheerio";
import { URL } from "url";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const siteUrl = searchParams.get("url");

  if (!siteUrl) {
    return NextResponse.json({ error: "Missing URL parameter" }, { status: 400 });
  }

  try {
    // Ensure URL has a protocol
    let targetUrl = siteUrl;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = "https://" + targetUrl;
    }

    const response = await axios.get(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 5000,
    });

    const $ = cheerio.load(response.data);

    const icon =
      $('link[rel="apple-touch-icon"]').attr("href") ||
      $('link[rel="icon"]').attr("href") ||
      $('link[rel="shortcut icon"]').attr("href");

    if (icon) {
      const iconUrl = new URL(icon, targetUrl).href;
      return NextResponse.json({ iconUrl });
    }

    // Fallback to default favicon.ico
    const defaultIcon = new URL("/favicon.ico", targetUrl).href;
    return NextResponse.json({ iconUrl: defaultIcon });
  } catch (error: any) {
    console.error("Favicon fetch error:", error.message);
    
    // If we can't fetch the page, try the default /favicon.ico as a last resort
    try {
        let targetUrl = siteUrl;
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = "https://" + targetUrl;
        }
        const defaultIcon = new URL("/favicon.ico", targetUrl).href;
        return NextResponse.json({ iconUrl: defaultIcon });
    } catch (e) {
        return NextResponse.json({ error: "Could not fetch favicon" }, { status: 500 });
    }
  }
}
