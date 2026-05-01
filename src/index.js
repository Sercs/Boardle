export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    // --- R2 FALLBACK LOGIC ---
    const r2Status = env.BUCKET ? "Bound" : "Not Bound";
    
    if (env.BUCKET && targetUrl && targetUrl.startsWith('http')) {
      try {
        const targetUrlObj = new URL(targetUrl);
        let filename = targetUrlObj.pathname.split('/').pop();
        
        if (filename.endsWith('.sqlite3') || filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
          try {
            const object = await env.BUCKET.get(filename);
            if (object) {
              const headers = new Headers();
              object.writeHttpMetadata(headers);
              headers.set("Access-Control-Allow-Origin", "*");
              headers.set("X-Proxy-Source", "R2-Bucket");
              headers.set("X-R2-Status", r2Status);
              return new Response(object.body, { headers });
            }
          } catch (e) {
            console.error('R2 Error:', e);
          }
        }
      } catch (e) {
        console.warn('URL Parse Error:', e);
      }
    }

    if (!targetUrl) {
      return new Response("Missing URL parameter", { status: 400 });
    }

    // Standard Proxy Fallback
    try {
      const headers = new Headers(request.headers);
      headers.set("Origin", new URL(targetUrl).origin);
      
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: "follow",
      });

      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      newResponse.headers.set("X-Proxy-Origin", "boardle-worker");
      newResponse.headers.set("X-R2-Status", r2Status);
      return newResponse;
    } catch (err) {
      return new Response(err.message, { status: 500 });
    }
  },
};
