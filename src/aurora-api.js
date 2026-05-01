
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

// Helper to download the official APK and extract the starter database (BoardLib style)
export async function downloadAPKDatabase(board) {
  const packageNames = {
    "aurora": "auroraboard",
    "tension": "tensionboard2",
    "kilter": "kilterboard",
    "grasshopper": "grasshopperboard"
  };

  const packageName = packageNames[board] || packageNames['tension'];
  const apkUrl = `https://d.apkpure.net/b/APK/com.auroraclimbing.${packageName}?version=latest`;
  
  console.log(`[APK] Downloading ${board} APK from APKPure...`);
  const proxyUrl = `${PROXY_URL}?url=${encodeURIComponent(apkUrl)}`;
  
  const response = await fetch(proxyUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) throw new Error(`Failed to download APK: ${response.status}`);

  const bundleBlob = await response.blob();
  
  // Load JSZip dynamically
  const JSZip = (await import('https://cdn.skypack.dev/jszip')).default;
  const zip = new JSZip();
  const bundle = await zip.loadAsync(bundleBlob);

  console.log(`[APK] Extracting database...`);
  
  // APKPure sometimes serves an XAPK (a zip containing the APK)
  let dbFile;
  const apkEntry = bundle.file(`com.auroraclimbing.${packageName}.apk`);
  
  if (apkEntry) {
    const apkBlob = await apkEntry.async('blob');
    const mainZip = await zip.loadAsync(apkBlob);
    dbFile = mainZip.file('assets/db.sqlite3');
  } else {
    // Direct APK
    dbFile = bundle.file('assets/db.sqlite3');
  }

  if (!dbFile) throw new Error('Could not find assets/db.sqlite3 in APK');

  return await dbFile.async('arraybuffer');
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
