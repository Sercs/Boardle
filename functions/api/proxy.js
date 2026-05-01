export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  // --- R2 FALLBACK LOGIC ---
  const r2Status = env.BUCKET ? "Bound" : "Not Bound";
  
  if (env.BUCKET && targetUrl) {
    // Extract filename and remove any query strings or leading slashes
    let filename = new URL(targetUrl).pathname.split('/').pop();
    
    if (filename.endsWith('.sqlite3') || filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
      try {
        console.log(`[Proxy] R2 Lookup: "${filename}"`);
        const object = await env.BUCKET.get(filename);
        if (object) {
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set("Access-Control-Allow-Origin", "*");
          headers.set("X-Proxy-Source", "R2-Bucket");
          headers.set("X-R2-Status", r2Status);
          headers.set("X-R2-Filename", filename);
          return new Response(object.body, { headers });
        } else {
          console.warn(`[Proxy] R2 Miss: "${filename}" not found in bucket.`);
        }
      } catch (e) {
        console.error('[Proxy] R2 Error:', e);
      }
    }
  }

  const allowedHosts = [
    'auroraclimbing.com',
    'tensionboardapp2.com',
    'kilterboard.com',
    'grasshopperboard.com',
    'apkpure.net',
    'apkpure.com',
    'winudf.com',
    'googleusercontent.com'
  ];

  const isAllowed = allowedHosts.some(host => targetUrl && targetUrl.includes(host));

  if (!targetUrl || !isAllowed) {
    return new Response('Forbidden Host or Missing URL', { status: 403 });
  }

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Aurora-Token",
      },
    });
  }

  try {
    const headers = new Headers(request.headers);
    // Remove headers that might cause issues, but KEEP 'origin' for POST requests
    headers.delete("host");
    
    // Set a fake referer to look like we're coming from the APKPure site
    if (targetUrl.includes('apkpure') || targetUrl.includes('winudf')) {
      headers.set("Referer", "https://apkpure.com/");
      headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    } else {
      headers.delete("referer");
      headers.set("User-Agent", "Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0");
    }

    // Handle the custom token header we use to pass session info
    const token = headers.get("X-Aurora-Token");
    if (token) {
      headers.set("Cookie", `token=${token}`);
      headers.delete("X-Aurora-Token");
    }

    const body = (request.method !== "GET" && request.method !== "HEAD") 
      ? await request.arrayBuffer() 
      : undefined;

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: body,
      redirect: "follow",
    });

    // Create a new response so we can modify headers
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    newResponse.headers.set("X-Proxy-Origin", "boardle-proxy");
    newResponse.headers.set("X-R2-Status", r2Status);
    
    return newResponse;
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { 
      status: 500, 
      headers: { "Access-Control-Allow-Origin": "*" } 
    });
  }
}
