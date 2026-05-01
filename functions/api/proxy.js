export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  const allowedHosts = [
    'auroraclimbing.com',
    'tensionboardapp2.com',
    'kilterboard.com',
    'grasshopperboard.com',
    'apkpure.net',
    'apkpure.com'
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
    // Remove headers that might cause issues with the target server
    headers.delete("host");
    headers.delete("origin");
    headers.delete("referer");

    // Handle the custom token header we use to pass session info
    const token = headers.get("X-Aurora-Token");
    if (token) {
      headers.set("Cookie", `token=${token}`);
      headers.delete("X-Aurora-Token");
    }

    // Impersonate the official app
    headers.set("User-Agent", "Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0");

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
    
    return newResponse;
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { 
      status: 500, 
      headers: { "Access-Control-Allow-Origin": "*" } 
    });
  }
}
