const ARCHIVE_ROOT = "https://archive.org/download/scovery/";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata/scovery";
const MANUAL_FOLDER_ORDER_URL = "./directory.time.txt";

const AUDIO_EXTENSIONS = new Set([
  "mp3", "flac", "wav", "ogg", "oga", "m4a", "aac", "opus", "aiff", "alac"
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const PREFERRED_AUDIO_ORDER = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "alac"];
const MIME_BY_EXTENSION = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  aiff: "audio/aiff",
  alac: "audio/mp4",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp"
};

const manualFolderOrderCache = { value: null, promise: null };
let currentFolder = null;
let currentFolderFiles = [];
let webampInstance = null;

const $ = (selector) => document.querySelector(selector);

function normalizeName(text) {
  return decodeURIComponent(text.replace(/\/$/, "")).trim();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(bytes >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function archiveURL(path = "") {
  const cleanPath = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
  return cleanPath ? ARCHIVE_ROOT + cleanPath.split("/").map(encodeURIComponent).join("/") : ARCHIVE_ROOT;
}

function normalizeExtension(name) {
  return (name.split(".").pop() || "").toLowerCase();
}

function stripImageSuffix(name) {
  return name.replace(/_spectrogram(?=\.[^.]+$)/i, "").replace(/-spectrogram(?=\.[^.]+$)/i, "");
}

function normalizeAudioStem(name) {
  const base = stripImageSuffix(name).split(".").slice(0, -1).join(".");
  return (base || name).replace(/_spectrogram$/i, "").replace(/-spectrogram$/i, "").trim();
}

function normalizeManualFolderName(value) {
  return String(value || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/gi, "")
    .trim()
    .toLowerCase();
}

function isSpectrogramFile(name) {
  const lower = name.toLowerCase();
  return lower.includes("_spectrogram") || lower.includes("-spectrogram");
}

function isAudioFileName(name) {
  return AUDIO_EXTENSIONS.has(normalizeExtension(name));
}

function isImageFileName(name) {
  return IMAGE_EXTENSIONS.has(normalizeExtension(name));
}

function browserSupportsMime(mimeType) {
  const audio = document.createElement("audio");
  return !!mimeType && audio.canPlayType(mimeType) !== "";
}

function dateFromFolderName(name) {
  const match = name.match(/(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4})/i);
  if (!match) return null;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = monthNames.findIndex(v => v.toLowerCase() === match[2].toLowerCase());
  if (monthIndex < 0) return null;
  const iso = `${match[3]}-${String(monthIndex + 1).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
  return Date.parse(iso);
}

function sortFoldersByDate(folders) {
  return [...folders].sort((a, b) => {
    const aDate = dateFromFolderName(a.name) ?? 0;
    const bDate = dateFromFolderName(b.name) ?? 0;
    if (aDate !== bDate) return bDate - aDate;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

function sortFilesByName(files) {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function parseManualFolderOrder(text) {
  const order = new Map();
  let index = 0;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[") || line.startsWith("http")) continue;

    const folderName = line.split(":")[0].trim();
    if (!folderName) continue;

    order.set(normalizeManualFolderName(folderName), index);
    index += 1;
  }

  return order;
}

async function fetchManualFolderOrder() {
  if (manualFolderOrderCache.value) return manualFolderOrderCache.value;
  if (manualFolderOrderCache.promise) return manualFolderOrderCache.promise;

  manualFolderOrderCache.promise = fetch(MANUAL_FOLDER_ORDER_URL, { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) return new Map();
      return response.text().then(text => parseManualFolderOrder(text));
    })
    .catch(() => new Map())
    .then((result) => {
      manualFolderOrderCache.value = result;
      return result;
    })
    .finally(() => {
      manualFolderOrderCache.promise = null;
    });

  return manualFolderOrderCache.promise;
}

function sortFoldersByManualOrder(folders, orderMap) {
  if (!orderMap || !orderMap.size) return sortFoldersByDate(folders);

  return [...folders].sort((a, b) => {
    const aKey = normalizeManualFolderName(a.name);
    const bKey = normalizeManualFolderName(b.name);
    const aIndex = orderMap.get(aKey);
    const bIndex = orderMap.get(bKey);

    if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
    if (aIndex !== undefined) return -1;
    if (bIndex !== undefined) return 1;

    const aDate = dateFromFolderName(a.name) ?? 0;
    const bDate = dateFromFolderName(b.name) ?? 0;
    if (aDate !== bDate) return bDate - aDate;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

const ArchiveAPI = {
  cache: new Map(),

  async fetchDirectory(path = "") {
    const key = path || "";
    if (this.cache.has(key)) return this.cache.get(key);

    const promise = fetch(ARCHIVE_METADATA_URL, {
      headers: { Accept: "application/json" },
      cache: "no-cache"
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Archive.org returned HTTP ${response.status}`);
      return response.json();
    }).then((data) => parseDirectoryMetadata(data, key));

    this.cache.set(key, promise);
    return promise;
  },

  async getFolders() {
    const entries = await this.fetchDirectory("");
    const ordered = sortFoldersByDate(entries.filter(e => e.type === "folder"));
    const manualOrder = await fetchManualFolderOrder();
    return sortFoldersByManualOrder(ordered, manualOrder);
  },

  async getFolderEntries(folder) {
    const entries = await this.fetchDirectory(folder);
    return sortFilesByName(entries.filter(e => e.type === "file"));
  },

  async getAudioFiles(folder) {
    const entries = await this.fetchDirectory(folder);
    const audioEntries = entries.filter(e => e.type === "file" && isAudioFileName(e.name));
    const groups = new Map();

    for (const entry of audioEntries) {
      const stem = normalizeAudioStem(entry.name);
      if (!stem) continue;
      if (!groups.has(stem)) groups.set(stem, []);
      groups.get(stem).push(entry);
    }

    const chosen = [...groups.values()].map((group) => {
      const ordered = group.sort((a, b) => {
        const aExt = normalizeExtension(a.name);
        const bExt = normalizeExtension(b.name);
        const aIndex = PREFERRED_AUDIO_ORDER.indexOf(aExt);
        const bIndex = PREFERRED_AUDIO_ORDER.indexOf(bExt);
        const aSupported = browserSupportsMime(MIME_BY_EXTENSION[aExt]) ? 1 : 0;
        const bSupported = browserSupportsMime(MIME_BY_EXTENSION[bExt]) ? 1 : 0;
        if (aSupported !== bSupported) return bSupported - aSupported;
        if (aIndex !== bIndex) return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      return ordered[0];
    });

    return sortFilesByName(chosen);
  }
};

function parseDirectoryMetadata(data, folderPath = "") {
  const files = Array.isArray(data?.files) ? data.files : [];
  const prefix = folderPath ? folderPath.replace(/^\/+|\/+$/g, "") : "";

  if (!prefix) {
    const folders = new Map();

    for (const entry of files) {
      const rawName = entry?.name || "";
      if (!rawName || !rawName.includes("/")) continue;

      const relative = rawName.replace(/^\/+/, "");
      const folderName = relative.split("/")[0];
      if (!folderName || folderName.includes(".")) continue;

      const key = folderName;
      if (!folders.has(key)) {
        folders.set(key, {
          name: folderName,
          path: folderName,
          type: "folder",
          size: ""
        });
      }
    }

    return [...folders.values()];
  }

  const folderPrefix = `${prefix}/`;
  const entries = [];
  const seen = new Set();

  for (const entry of files) {
    const rawName = entry?.name || "";
    if (!rawName.startsWith(folderPrefix)) continue;

    const relativePath = rawName.slice(folderPrefix.length);
    if (!relativePath || relativePath.startsWith("/")) continue;

    const basename = relativePath.split("/").at(-1) || relativePath;
    if (!basename || basename === "") continue;

    const fileName = basename;
    const key = `${prefix}/${fileName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isFile = !relativePath.includes("/");
    if (!isFile) continue;

    entries.push({
      name: fileName,
      path: `${prefix}/${fileName}`,
      type: "file",
      size: entry.size ? formatBytes(Number(entry.size)) : ""
    });
  }

  return entries;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

function scoreNameMatch(target, candidateName) {
  const targetName = normalizeManualFolderName(target || "");
  const candidate = normalizeManualFolderName(candidateName || "");

  if (!targetName || !candidate) return 0;
  if (targetName === candidate) return 100;
  if (candidate.includes(targetName) || targetName.includes(candidate)) return 80;

  const targetWords = new Set(targetName.split(" ").filter(Boolean));
  const candidateWords = new Set(candidate.split(" ").filter(Boolean));
  const overlap = [...targetWords].filter(word => candidateWords.has(word)).length;
  return overlap ? 35 + overlap * 12 : 0;
}

function findFolderArt(entries, folderName = "", preferredStem = "") {
  const candidates = entries.filter((entry) => {
    if (!isImageFileName(entry.name) || isSpectrogramFile(entry.name)) return false;
    return true;
  });

  if (!candidates.length) return null;

  const audioStems = entries
    .filter((entry) => isAudioFileName(entry.name))
    .map((entry) => normalizeAudioStem(entry.name))
    .filter(Boolean);

  const ranked = candidates.map((entry) => {
    const cleanedName = stripImageSuffix(entry.name);
    let score = Math.max(
      scoreNameMatch(folderName, cleanedName),
      scoreNameMatch(preferredStem, cleanedName),
      ...audioStems.map(stem => scoreNameMatch(stem, cleanedName))
    );

    if (/(cover|art|album|front|folder|main)/i.test(cleanedName)) score += 12;
    if (folderName && normalizeManualFolderName(cleanedName).includes(normalizeManualFolderName(folderName))) score += 15;

    return { entry, score };
  }).sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true }));

  return archiveURL(`${ranked[0].entry.path}`);
}

function findSpectrogram(entries, preferredStem = "") {
  const matchStem = preferredStem || "";
  const candidates = entries.filter((entry) => isImageFileName(entry.name) && isSpectrogramFile(entry.name));
  
  if (!matchStem) return null; // Ne renvoie rien si on ne cherche pas un stem précis

  const exact = candidates.find((entry) => normalizeAudioStem(entry.name) === matchStem);
  if (exact) return archiveURL(`${exact.path}`);

  const partial = candidates.find((entry) => normalizeAudioStem(entry.name).startsWith(matchStem) || matchStem.startsWith(normalizeAudioStem(entry.name)));
  
  // Correction: Si on trouve un partiel on le renvoie, SINON on renvoie null pour permettre le fallback sur la vignette/cover
  return partial ? archiveURL(`${partial.path}`) : null; 
}

function setTrackArt(imageUrl) {
  const art = $("#trackArt");
  if (!art) return;
  if (!imageUrl) {
    art.hidden = true;
    art.removeAttribute("src");
    return;
  }
  art.src = imageUrl;
  art.hidden = false;
}

function setActiveTrack(row) {
  document.querySelectorAll(".track").forEach((item) => item.classList.toggle("is-active", item === row));
}

async function resolveFolderArt(folder) {
  try {
    const entries = await ArchiveAPI.getFolderEntries(folder.path);
    return findFolderArt(entries, folder.name);
  } catch (error) {
    console.warn("Could not resolve folder art", error);
    return null;
  }
}

async function renderFolders(folders) {
  const container = $("#folders");
  $("#folderCount").textContent = folders.length;
  container.innerHTML = "";

  for (const [index, folder] of folders.entries()) {
    const artUrl = await resolveFolderArt(folder);
    const button = document.createElement("button");
    button.className = "folder";
    button.type = "button";
    button.setAttribute("title", folder.name);

    if (artUrl) {
      button.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.10), rgba(0,0,0,0.65)), url("${artUrl}")`;
      button.style.backgroundSize = "cover";
      button.style.backgroundPosition = "center";
    }

    button.innerHTML = `
      <div class="folder-content">
        <span class="folder-number">${String(index + 1).padStart(2, "0")} / ${String(folders.length).padStart(2, "0")}</span>
        <span class="folder-arrow">↗</span>
        <span class="folder-name">${escapeHTML(folder.name)}</span>
      </div>
    `;
    button.addEventListener("click", () => openFolder(folder));
    container.appendChild(button);
  }
}

function openWebamp(folder, files) {
  if (typeof Webamp === "undefined") {
    const meta = $("#playerMeta");
    if (meta) meta.textContent = "Webamp n'est pas disponible ou la ressource n'a pas chargé.";
    return;
  }

  // Destruction de l'ancienne instance de webamp pour éviter les crashs 
  if (webampInstance) {
    webampInstance.dispose();
    webampInstance = null;
  }

  const holder = $("#webampContainer") || document.body; // Fallback sécurisé

  if (holder !== document.body) {
    holder.innerHTML = "";
  }

  const playlist = files.map((file) => ({
    metaData: {
      artist: folder.name,
      title: file.name
    },
    url: archiveURL(`${folder.path}/${file.name}`),
    duration: 0
  }));

  webampInstance = new Webamp({
    initialTracks: playlist,
    autoplay: false
    // J'ai retiré le availableSkins potentiellement mort qui empêche le load
  });

  webampInstance.renderWhenReady(holder).then(() => {
    if (holder !== document.body && holder.classList) {
        holder.classList.add("is-visible");
    }
  });
}

async function openFolder(folder) {
  const drawer = $("#drawer");
  const title = $("#drawerTitle");
  const meta = $("#drawerMeta");
  const tracks = $("#tracks");
  const openFolderLink = $("#openFolder");
  const audioPlayer = $("#audioPlayer");
  const playerMeta = $("#playerMeta");

  currentFolder = folder;
  currentFolderFiles = [];

  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  // Ajout de la note pour Scovery26 et This world is ending
  title.innerHTML = escapeHTML(folder.name);
  if (folder.name.toLowerCase() === "scovery26" || folder.name.toLowerCase() === "this world is ending") {
    title.innerHTML += `<br><span style="font-size: 0.65em; font-weight: normal; opacity: 0.8;">(Note : les musiques sont les mêmes dans Scovery26 et This world is ending)</span>`;
  }

  meta.textContent = "Loading directory…";
  tracks.innerHTML = "";
  openFolderLink.href = archiveURL(folder.path);

  setTrackArt(null);
  if (playerMeta) playerMeta.textContent = "Play a track to load the spectrogram or cover art.";
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }

  try {
    const folderEntries = await ArchiveAPI.getFolderEntries(folder.path);
    const files = await ArchiveAPI.getAudioFiles(folder.path);
    currentFolderFiles = files;
    const folderArt = findFolderArt(folderEntries, folder.name);
    if (folderArt) setTrackArt(folderArt);

    meta.textContent = `${files.length} audio file${files.length === 1 ? "" : "s"} · loaded on demand`;

    if (!files.length) {
      tracks.innerHTML = `<div class="error">No supported audio files were found in this folder.</div>`;
      return;
    }

    files.forEach((file, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "track";
      const href = archiveURL(`${folder.path}/${file.name}`);

      row.innerHTML = `
        <span class="track-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="track-name">${escapeHTML(file.name)}</span>
        <span class="track-size">${escapeHTML(file.size)}</span>
      `;

      row.addEventListener("click", () => {
        setActiveTrack(row);
        if (audioPlayer) {
          audioPlayer.src = href;
          audioPlayer.load();
          const stem = normalizeAudioStem(file.name);
          
          // Cherche un spectrogramme exact, SINON retourne la vignette (folderArt)
          const spectrogram = findSpectrogram(folderEntries, stem) || folderArt;
          if (spectrogram) setTrackArt(spectrogram);
          
          if (playerMeta) playerMeta.textContent = `${folder.name} • ${file.name}`;
          audioPlayer.play().catch(() => {
            if (playerMeta) playerMeta.textContent = `${folder.name} • ${file.name} (tap play to start)`;
          });
        }
      });

      tracks.appendChild(row);
    });
  } catch (error) {
    console.error(error);
    meta.textContent = "Could not load directory";
    tracks.innerHTML = `
      <div class="error">
        Archive.org could not be queried from this browser.
        <br><br>
        ${escapeHTML(error.message)}
      </div>`;
  }
}

function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

$("#drawer").addEventListener("click", (event) => {
  if (event.target.matches("[data-close]")) closeDrawer();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});

const webampToggle = $("#openWebamp");
if (webampToggle) {
  webampToggle.addEventListener("click", () => {
    if (!currentFolder) return;
    openWebamp(currentFolder, currentFolderFiles);
  });
}

(async function init() {
  try {
    const folders = await ArchiveAPI.getFolders();
    await renderFolders(folders);
    $("#status").textContent =
      `${folders.length} directories found · contents are loaded only when opened.`;
  } catch (error) {
    console.error(error);
    $("#status").innerHTML = `
      <div class="error">
        Impossible de lire l'index Archive.org depuis le navigateur.
        ${escapeHTML(error.message)}
      </div>`;
  }
})();