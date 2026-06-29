import { type NextRequest, NextResponse } from "next/server"

const FLASK_BASE = process.env.FLASK_BASE || "http://localhost:5050"

type Params = Promise<{ path: string[] }>

export async function GET(req: NextRequest, { params }: { params: Params }) {
  const { path } = await params
  return proxy(req, path)
}
export async function POST(req: NextRequest, { params }: { params: Params }) {
  const { path } = await params
  return proxy(req, path)
}
export async function PUT(req: NextRequest, { params }: { params: Params }) {
  const { path } = await params
  return proxy(req, path)
}
export async function DELETE(req: NextRequest, { params }: { params: Params }) {
  const { path } = await params
  return proxy(req, path)
}
export async function OPTIONS(req: NextRequest, { params }: { params: Params }) {
  const { path } = await params
  return proxy(req, path)
}

async function proxy(req: NextRequest, pathSegments: string[]) {
  const path = pathSegments.join("/")
  const url = new URL(req.url)
  const targetUrl = `${FLASK_BASE}/${path}${url.search}`

  const incomingCookie = req.headers.get("cookie") || ""

  const headers: Record<string, string> = {
    "Content-Type": req.headers.get("content-type") || "application/json",
  }
  if (incomingCookie) headers["cookie"] = incomingCookie

  let body: BodyInit | undefined
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.text()
  }

  const flaskRes = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
  })

  const responseBody = await flaskRes.arrayBuffer()

  const res = new NextResponse(responseBody, {
    status: flaskRes.status,
    statusText: flaskRes.statusText,
  })

  // Forward Flask's response headers back to the browser — except the ones
  // describing the original response's transport encoding/size. fetch()
  // already transparently decompresses gzip/br responses by the time we
  // read flaskRes.arrayBuffer() above, so the bytes we're sending the
  // browser are plain, not compressed. Forwarding the original
  // "content-encoding: gzip" (etc.) header anyway told the browser "this
  // body is still gzip-compressed" when it no longer was, which made it
  // fail to decode the response (net::ERR_CONTENT_DECODING_FAILED) even
  // though the request itself succeeded with a 200. Same issue for
  // content-length, since the decoded body's byte length differs from the
  // original compressed length.
  const skipHeaders = [
    "transfer-encoding",
    "connection",
    "content-encoding",
    "content-length",
  ]
  flaskRes.headers.forEach((value, key) => {
    if (!skipHeaders.includes(key.toLowerCase())) {
      res.headers.append(key, value)
    }
  })

  return res
}
