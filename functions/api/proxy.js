export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  // --- R2 FALLBACK LOGIC ---
  const bucket = env.BUCKET || Object.values(env).find(v => v && typeof v.get === 'function');
  const r2Status = bucket ? "Bound" : "Not Bound";
  
  if (bucket && targetUrl && targetUrl.startsWith('http')) {
    try {
      const targetUrlObj = new URL(targetUrl);
      let filename = targetUrlObj.pathname.split('/').pop();
      
      if (filename.endsWith('.sqlite3') || filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
        try {
          console.log(`[Proxy] R2 Lookup: "${filename}"`);
          const object = await bucket.get(filename);
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
    } catch (e) {
      console.warn('[Proxy] URL Parse Error:', e);
    }
  }

  const allowedHosts = [
    'auroraclimbing.com',
    'tensionboardapp2.com',
    'kilterboard.com',
    'grasshopperboard.com',
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
    
    headers.delete("referer");
    headers.set("User-Agent", "Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0");

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
