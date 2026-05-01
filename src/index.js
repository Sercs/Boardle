export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    // --- R2 FALLBACK LOGIC ---
    const bucket = env.BUCKET || Object.values(env).find(v => v && typeof v.get === 'function');
    const r2Status = bucket ? "Bound" : "Not Bound";
    
    // Version marker to confirm deployment
    const WORKER_VERSION = "boardle-worker-v3";
    
    if (bucket && targetUrl && targetUrl.startsWith('http')) {
      try {
        const targetUrlObj = new URL(targetUrl);
        let filename = targetUrlObj.pathname.split('/').pop();
        
        if (filename.endsWith('.sqlite3') || filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
          try {
            const object = await bucket.get(filename);
            if (object) {
              const headers = new Headers();
              object.writeHttpMetadata(headers);
              headers.set("Access-Control-Allow-Origin", "*");
              headers.set("X-Proxy-Source", "R2-Bucket");
              headers.set("X-R2-Status", r2Status);
              headers.set("X-R2-Filename", filename);
              headers.set("X-Worker-Version", WORKER_VERSION);
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
      // If it's not a proxy request, just let the static assets handle it
      return new Response(`Boardle Worker (${WORKER_VERSION})`, { status: 200 });
    }

    // Standard Proxy Fallback
    try {
      const headers = new Headers(request.headers);
      if (targetUrl.startsWith('http')) {
        headers.set("Origin", new URL(targetUrl).origin);
      }
      
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
        redirect: "follow",
      });

      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      newResponse.headers.set("X-Proxy-Origin", WORKER_VERSION);
      newResponse.headers.set("X-R2-Status", r2Status);
      return newResponse;
    } catch (err) {
      return new Response(err.message, { status: 500 });
    }
  },
};
