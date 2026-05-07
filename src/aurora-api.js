
const HOST_BASES = {
  aurora: "auroraclimbing",
  tension: "tensionboardapp2",
  kilter: "kilterboard",
  grasshopper: "grasshopperboard",
};

const WEB_HOSTS = Object.fromEntries(
  Object.entries(HOST_BASES).map(([board, hostBase]) => [
    board,
    `https://api.${hostBase}.com`,
  ])
);

const DEFAULT_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0",
};

// This should be your Cloudflare Worker URL
const PROXY_URL = "/api/proxy"; 

/**
 * Helper to build a proxied URL
 */
function getProxiedUrl(targetUrl) {
  return `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Log in to a board and return the session token
 */
export async function login(board, username, password) {
  const url = getProxiedUrl(`${WEB_HOSTS[board]}/api/v1/sessions`);
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      password,
      tou: "accepted",
      pp: "accepted",
      ua: "app",
    }),
  });

  if (response.status === 422) {
    throw new Error("Invalid username or password. Please check your credentials and try again.");
  }

  if (!response.ok) {
    throw new Error(`Login failed with status: ${response.status}`);
  }

  const data = await response.json();
  return data.session.token;
}

// Helper to fetch the raw database file directly (from R2 or similar)
export async function fetchDatabase(board, onProgress) {
  console.log(`[Database] Attempting direct fetch for ${board}.sqlite3...`);
  // We use a dummy URL that ends in .sqlite3 so the proxy checks R2
  const dummyUrl = `https://tensionboardapp2.com/${board}.sqlite3`;
  const proxyUrl = `${PROXY_URL}?url=${encodeURIComponent(dummyUrl)}`;
  
  const response = await fetch(proxyUrl);
  console.log(`[Database] Proxy Response: ${response.status} (${response.headers.get('X-Proxy-Source') || 'Internet'})`);
  
  if (!response.ok) {
    throw new Error(`Direct fetch failed: ${response.status}`);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  const reader = response.body.getReader();
  const chunks = [];
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    chunks.push(value);
    loaded += value.length;
    
    if (onProgress && total) {
      onProgress(loaded / total);
    }
  }

  const buffer = new Uint8Array(loaded);
  let position = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, position);
    position += chunk.length;
  }

  // Check if it's actually a sqlite file (starts with "SQLite format 3")
  const header = new TextDecoder().decode(buffer.slice(0, 15));
  if (header !== "SQLite format 3") {
    throw new Error("Downloaded file is not a valid SQLite database");
  }

  return buffer.buffer;
}


export function getImageUrl(board, filename) {
  const apiHost = `https://api.${HOST_BASES[board]}.com`;
  const targetUrl = `${apiHost}/img/${filename}`;
  return `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Sync tables from a board
 */
export async function* sync(board, tablesAndSyncDates, token = null, maxPages = 100) {
  const url = getProxiedUrl(`${WEB_HOSTS[board]}/api/v1/sync`);
  const headers = {
    ...DEFAULT_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (token) {
    // We send the token as a custom header to avoid browser cookie issues.
    // The Cloudflare Worker proxy should convert this to a Cookie: token=... header.
    headers["X-Aurora-Token"] = token;
  }

  let payloadDict = { ...tablesAndSyncDates };
  let pageCount = 0;
  let complete = false;

  while (!complete && pageCount < maxPages) {
    // Aurora expects exact URL-encoded form data
    const body = new URLSearchParams();
    for (const [table, syncDate] of Object.entries(payloadDict)) {
      body.append(table, syncDate);
    }

    const bodyStr = body.toString();
    
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Sync failed with status: ${response.status}`);
      }

      const responseJson = await response.json();
      
      complete = responseJson._complete || false;
      delete responseJson._complete;

      yield responseJson;

      // Update payload with last sync date for next page
      if (token && responseJson.user_syncs) {
        for (const userSync of responseJson.user_syncs) {
          const { table_name, last_synchronized_at } = userSync;
          if (payloadDict[table_name] && last_synchronized_at) {
            payloadDict[table_name] = last_synchronized_at;
          }
        }
      }

      if (responseJson.shared_syncs) {
        for (const sharedSync of responseJson.shared_syncs) {
          const { table_name, last_synchronized_at } = sharedSync;
          if (payloadDict[table_name] && last_synchronized_at) {
            payloadDict[table_name] = last_synchronized_at;
          }
        }
      }
    } catch (e) {
      console.error(`[Sync] Request Error:`, e);
      throw e;
    }

    pageCount++;
  }
}

/**
 * Download an image for a board
 */
export async function fetchImage(board, imageFilename) {
  const apiHost = `https://api.${HOST_BASES[board]}.com`;
  const url = getProxiedUrl(`${apiHost}/img/${imageFilename}`);
  
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${imageFilename}`);
  }

  return response.blob();
}
