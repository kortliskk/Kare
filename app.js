"use strict";

/* =========================================================
   KARE — ANA UYGULAMA
   ========================================================= */

const state = {
  user: null,
  items: [],
  filter: "all",
  query: "",
  newestFirst: true,
  addMode: "manual",
  selectedKind: "movie",
  imported: null,
  authMode: "register",
  activeDetailId: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const GUEST_KEY = "kare_guest_items_v1";

const dialogs = [
  "addDialog",
  "authDialog",
  "detailDialog",
  "childDialog"
];

/* =========================================================
   SUPABASE BAĞLANTISI
   ========================================================= */

let dbClient = null;

try {
  if (
    window.supabase &&
    typeof window.supabase.createClient === "function" &&
    window.KARE_CONFIG &&
    window.KARE_CONFIG.supabaseUrl &&
    window.KARE_CONFIG.supabaseAnonKey
  ) {
    dbClient = window.supabase.createClient(
      window.KARE_CONFIG.supabaseUrl,
      window.KARE_CONFIG.supabaseAnonKey
    );
  }
} catch (error) {
  console.error("Supabase başlatılamadı:", error);
}

function isSupabaseReady() {
  return Boolean(dbClient);
}

async function getCurrentUser() {
  if (!dbClient) return null;

  try {
    const { data, error } = await dbClient.auth.getSession();

    if (error) throw error;

    return data.session?.user || null;
  } catch (error) {
    console.error("Oturum kontrolü:", error);
    return null;
  }
}

/* =========================================================
   YARDIMCI FONKSİYONLAR
   ========================================================= */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function safeImageUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol === "https:") {
      return url.href;
    }

    return "";
  } catch {
    return "";
  }
}

function makeId() {
  if (window.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return "kare-" + Date.now() + "-" +
    Math.random().toString(36).slice(2);
}

function guestItems() {
  try {
    const data = JSON.parse(
      localStorage.getItem(GUEST_KEY) || "[]"
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveGuest(items) {
  localStorage.setItem(GUEST_KEY, JSON.stringify(items));
}

function normalizeItem(row) {
  return {
    ...row,
    release_year: row.release_year || null,
    poster_url: row.poster_url || "",
    source_url: row.source_url || "",
    parent_id: row.parent_id || null,
    progress_season: Number(row.progress_season) || 1,
    progress_episode: Number(row.progress_episode) || 1
  };
}

function dbRow(row, userId) {
  const result = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    overview: row.overview || "",
    release_year: row.release_year || null,
    poster_url: row.poster_url || "",
    source_url: row.source_url || "",
    status: row.status || "planned",
    parent_id: row.parent_id || null,
    progress_season: row.progress_season || 1,
    progress_episode: row.progress_episode || 1,
    created_at: row.created_at
  };

  if (userId) {
    result.owner_id = userId;
  }

  return result;
}

/* =========================================================
   API VE VERİ İŞLEMLERİ
   ========================================================= */

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const body = options.body || {};

  const user = await getCurrentUser();
  const isGuest = !user;

  /* UYGULAMA AÇILIŞI */

  if (path === "/api/bootstrap") {
    state.user = user
      ? {
          id: user.id,
          email: user.email
        }
      : null;

    if (user && dbClient) {
      const { data, error } = await dbClient
        .from("items")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) throw error;

      state.items = (data || []).map(normalizeItem);
    } else {
      state.items = guestItems().map(normalizeItem);
    }

    return {
      user: state.user,
      items: state.items
    };
  }

  /* KAYIT VE GİRİŞ */

  if (path === "/api/register" || path === "/api/login") {
    if (!dbClient) {
      throw new Error(
        "Hesap işlemleri için Supabase bağlantısı gerekli. Misafir olarak içerik ekleyebilirsin."
      );
    }

    let result;

    if (path === "/api/register") {
      result = await dbClient.auth.signUp({
        email: body.email,
        password: body.password
      });
    } else {
      result = await dbClient.auth.signInWithPassword({
        email: body.email,
        password: body.password
      });
    }

    if (result.error) throw result.error;

    if (result.data.session && result.data.user) {
      await migrateGuest(result.data.user.id);
    }

    return {
      user: result.data.user
        ? {
            id: result.data.user.id,
            email: result.data.user.email
          }
        : null,
      message: result.data.session
        ? "Hesabın hazır."
        : "E-posta doğrulaması gerekiyorsa gelen kutunu kontrol et."
    };
  }

  /* ÇIKIŞ */

  if (path === "/api/logout") {
    if (!dbClient) return {};

    const { error } = await dbClient.auth.signOut();

    if (error) throw error;

    return {};
  }

  /* TMDB'DEN BİLGİ AL */

  if (path === "/api/import") {
    return {
      metadata: await importFromTmdb(body.url)
    };
  }

  /* İÇERİK EKLE */

  if (path === "/api/items" && method === "POST") {
    const row = {
      id: makeId(),
      kind: body.kind,
      title: body.title,
      overview: body.overview || "",
      release_year: body.year || null,
      poster_url: body.posterUrl || "",
      source_url: body.sourceUrl || "",
      status: "planned",
      parent_id: null,
      progress_season: 1,
      progress_episode: 1,
      created_at: new Date().toISOString()
    };

    if (isGuest) {
      const list = guestItems();
      list.push(row);
      saveGuest(list);
    } else {
      const { error } = await dbClient
        .from("items")
        .insert(dbRow(row, user.id));

      if (error) throw error;
    }

    return { item: row };
  }

  /* SEZON VE BÖLÜM EKLE */

  const childMatch = path.match(
    /^\/api\/items\/([^/]+)\/children$/
  );

  if (childMatch && method === "POST") {
    const parentId = decodeURIComponent(childMatch[1]);

    const row = {
      id: makeId(),
      kind: body.kind,
      title: body.title,
      overview: body.overview || "",
      release_year: null,
      poster_url: "",
      source_url: "",
      status: "planned",
      parent_id: parentId,
      progress_season: 1,
      progress_episode: 1,
      created_at: new Date().toISOString()
    };

    if (isGuest) {
      const list = guestItems();

      if (!list.some(item => item.id === parentId)) {
        throw new Error("Üst içerik bulunamadı.");
      }

      list.push(row);
      saveGuest(list);
    } else {
      const { error } = await dbClient
        .from("items")
        .insert(dbRow(row, user.id));

      if (error) throw error;
    }

    return { item: row };
  }

  /* İÇERİK GÜNCELLEME VE SİLME */

  const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);

  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);

    if (method === "PATCH") {
      const patch = {};

      if (body.status !== undefined) {
        patch.status = body.status;
      }

      if (body.progressSeason !== undefined) {
        patch.progress_season = body.progressSeason;
      }

      if (body.progressEpisode !== undefined) {
        patch.progress_episode = body.progressEpisode;
      }

      if (isGuest) {
        const list = guestItems();
        const index = list.findIndex(item => item.id === id);

        if (index < 0) {
          throw new Error("İçerik bulunamadı.");
        }

        list[index] = {
          ...list[index],
          ...patch
        };

        saveGuest(list);

        return {
          item: list[index]
        };
      }

      const { data, error } = await dbClient
        .from("items")
        .update(patch)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      return {
        item: normalizeItem(data)
      };
    }

    if (method === "DELETE") {
      if (isGuest) {
        const list = guestItems();
        const ids = new Set([id]);

        let changed = true;

        while (changed) {
          changed = false;

          for (const item of list) {
            if (
              ids.has(item.parent_id) &&
              !ids.has(item.id)
            ) {
              ids.add(item.id);
              changed = true;
            }
          }
        }

        saveGuest(
          list.filter(item => !ids.has(item.id))
        );
      } else {
        const { error } = await dbClient
          .from("items")
          .delete()
          .eq("id", id);

        if (error) throw error;
      }

      return {};
    }
  }

  throw new Error("Desteklenmeyen işlem.");
}

/* MİSAFİR İÇERİKLERİNİ HESABA AKTAR */

async function migrateGuest(userId) {
  if (!dbClient) return;

  const rows = guestItems();

  if (!rows.length) return;

  const payload = rows.map(row => dbRow(row, userId));

  const { error } = await dbClient
    .from("items")
    .upsert(payload);

  if (error) throw error;

  saveGuest([]);
}

/* =========================================================
   TMDB İÇERİK AKTARIMI
   ========================================================= */

async function importFromTmdb(input) {
  const apiKey = window.KARE_CONFIG?.tmdbApiKey;

  if (
    !apiKey ||
    apiKey.includes("TMDB_API_KEY") ||
    apiKey.includes("BURAYA")
  ) {
    throw new Error(
      "Otomatik ekleme için config.js dosyasına gerçek TMDB API anahtarını eklemelisin. Manuel ekleme kullanılabilir."
    );
  }

  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error("Geçerli bir bağlantı gir.");
  }

  const host = url.hostname.toLowerCase();

  const tmdbMatch =
    host.endsWith("themoviedb.org")
      ? url.pathname.match(/^\/(movie|tv)\/(\d+)/)
      : null;

  const imdbMatch =
    host.includes("imdb.com")
      ? url.pathname.match(/^\/title\/(tt\d+)/)
      : null;

  if (!tmdbMatch && !imdbMatch) {
    throw new Error(
      "TMDB film/dizi veya IMDb başlık bağlantısı destekleniyor."
    );
  }

  let kind;
  let id;

  if (tmdbMatch) {
    kind = tmdbMatch[1] === "movie" ? "movie" : "series";
    id = tmdbMatch[2];
  } else {
    const findResponse = await fetch(
      `https://api.themoviedb.org/3/find/${imdbMatch[1]}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`
    );

    const findData = await findResponse.json();

    const movie = findData.movie_results?.[0];
    const series = findData.tv_results?.[0];
    const hit = movie || series;

    if (!hit) {
      throw new Error(
        "IMDb kaydı TMDB üzerinde bulunamadı."
      );
    }

    kind = movie ? "movie" : "series";
    id = hit.id;
  }

  const category = kind === "movie" ? "movie" : "tv";

  const response = await fetch(
    `https://api.themoviedb.org/3/${category}/${id}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.status_message || "TMDB bilgisi alınamadı."
    );
  }

  return {
    kind,
    title: data.title || data.name || "",
    overview: data.overview || "",
    year: (
      data.release_date ||
      data.first_air_date ||
      ""
    ).slice(0, 4),
    posterUrl: data.poster_path
      ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
      : "",
    sourceUrl: `https://www.themoviedb.org/${category}/${id}`
  };
}

/* =========================================================
   BİLDİRİMLER VE BUTONLAR
   ========================================================= */

function showToast(message, type = "success") {
  const region = $("#toastRegion");

  if (!region) return;

  const toast = document.createElement("div");

  toast.className = `toast ${type}`;
  toast.textContent = message;

  region.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3800);
}

function setBusy(button, busy, label) {
  if (!button) return;

  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.textContent = label || "İşleniyor…";
  } else {
    button.disabled = false;

    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
    }

    delete button.dataset.originalText;
  }
}

function openDialog(id) {
  const dialog = document.getElementById(id);

  if (dialog && !dialog.open) {
    dialog.showModal();
  }
}

function closeDialog(id) {
  const dialog = document.getElementById(id);

  if (dialog?.open) {
    dialog.close();
  }
}

function getItem(id) {
  return state.items.find(item => item.id === id);
}

function childrenOf(parentId) {
  return state.items.filter(
    item => item.parent_id === parentId
  );
}

function roots() {
  return state.items.filter(
    item =>
      !item.parent_id &&
      ["movie", "series"].includes(item.kind)
  );
}

function formatKind(kind) {
  return {
    movie: "FİLM",
    series: "DİZİ",
    season: "SEZON",
    episode: "BÖLÜM"
  }[kind] || kind;
}

function formatStatus(status) {
  return {
    planned: "İzlenecek",
    watching: "İzleniyor",
    done: "Tamamlandı"
  }[status] || "İzlenecek";
}

/* =========================================================
   HESAP ALANI
   ========================================================= */

function updateAccount() {
  const avatar = $("#accountAvatar");
  const name = $("#accountName");
  const caption = $("#accountCaption");
  const action = $("#accountAction");
  const cta = $("#sidebarAuthBtn");

  if (!avatar || !name || !caption || !action || !cta) {
    return;
  }

  if (state.user) {
    const email = state.user.email || "Hesabım";

    avatar.textContent = email.slice(0, 1).toUpperCase();
    name.textContent = email;
    caption.textContent = "Senkronize hesap";

    action.title = "Oturumu kapat";
    action.setAttribute("aria-label", "Oturumu kapat");

    cta.hidden = true;
  } else {
    avatar.textContent = "M";
    name.textContent = "Misafir";
    caption.textContent = "Bu cihazda kayıtlı";

    action.title = "Hesap işlemleri";
    action.setAttribute("aria-label", "Hesap işlemleri");

    cta.hidden = false;
  }
}

/* =========================================================
   İSTATİSTİKLER
   ========================================================= */

function updateStats() {
  const all = roots();

  const movies = all.filter(
    item => item.kind === "movie"
  ).length;

  const series = all.filter(
    item => item.kind === "series"
  ).length;

  const done = all.filter(
    item => item.status === "done"
  ).length;

  $("#statTotal").textContent = all.length;
  $("#statMovies").textContent = movies;
  $("#statSeries").textContent = series;
  $("#statDone").textContent = done;

  $("#navCount").textContent = all.length;
  $("#allCount").textContent = all.length;
  $("#movieCount").textContent = movies;
  $("#seriesCount").textContent = series;

  $("#doneProgress").style.width = all.length
    ? `${Math.round(done / all.length * 100)}%`
    : "0%";
}

/* =========================================================
   KARTLAR
   ========================================================= */

function cardMarkup(item) {
  const image = safeImageUrl(item.poster_url);

  const year = item.release_year
    ? `<span class="card-year">${escapeHtml(item.release_year)}</span>`
    : "";

  function countDescendants(parentId) {
    return childrenOf(parentId).reduce(
      (sum, child) =>
        sum + 1 + countDescendants(child.id),
      0
    );
  }

  const childTotal =
    item.kind === "series"
      ? countDescendants(item.id)
      : 0;

  return `
    <article class="media-card">

      <div
        class="card-poster"
        role="button"
        tabindex="0"
        data-action="details"
        data-id="${escapeHtml(item.id)}"
        aria-label="${escapeHtml(item.title)} detaylarını aç"
      >
        ${
          image
            ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.title)} afişi" loading="lazy" referrerpolicy="no-referrer">`
            : `<div class="poster-placeholder">K.</div>`
        }

        <span class="card-type">
          ${formatKind(item.kind)}
        </span>

        ${year}
      </div>

      <div class="card-body">

        <div class="card-title-row">
          <strong class="card-title">
            ${escapeHtml(item.title)}
          </strong>

          <button
            class="card-menu"
            type="button"
            data-action="details"
            data-id="${escapeHtml(item.id)}"
          >···</button>
        </div>

        <p class="card-description">
          ${escapeHtml(
            item.overview ||
            (
              item.kind === "series"
                ? "Bölümlerini ve sezonlarını arşivinde tut."
                : "Bu hikâyeyi izleme listende sakla."
            )
          )}
        </p>

        <div class="card-meta">

          <select
            class="status-select status-${escapeHtml(item.status)}"
            aria-label="İzleme durumunu değiştir"
            data-action="status"
            data-id="${escapeHtml(item.id)}"
          >
            <option value="planned" ${item.status === "planned" ? "selected" : ""}>İzlenecek</option>
            <option value="watching" ${item.status === "watching" ? "selected" : ""}>İzleniyor</option>
            <option value="done" ${item.status === "done" ? "selected" : ""}>Tamamlandı</option>
          </select>

          ${
            item.kind === "series"
              ? `<span class="series-count">${childTotal} alt içerik</span>`
              : `<button class="card-detail-link" type="button" data-action="details" data-id="${escapeHtml(item.id)}">Detay ↗</button>`
          }

        </div>
      </div>
    </article>
  `;
}

/* =========================================================
   ARŞİVİ ÇİZ
   ========================================================= */

function render() {
  updateAccount();
  updateStats();

  const all = roots();

  let visible = all.filter(item =>
    state.filter === "all" ||
    item.kind === state.filter
  );

  if (state.query) {
    const query = state.query.toLocaleLowerCase("tr-TR");

    visible = visible.filter(item =>
      `${item.title} ${item.overview || ""}`
        .toLocaleLowerCase("tr-TR")
        .includes(query)
    );
  }

  visible.sort((a, b) =>
    state.newestFirst
      ? String(b.created_at).localeCompare(String(a.created_at))
      : String(a.created_at).localeCompare(String(b.created_at))
  );

  $("#contentGrid").innerHTML =
    visible.map(cardMarkup).join("");

  const noContent = all.length === 0;

  $("#emptyState").classList.toggle(
    "show",
    noContent && !state.query && state.filter === "all"
  );

  $("#contentGrid").hidden =
    noContent && !state.query && state.filter === "all";

  $("#noResults").hidden = !(
    visible.length === 0 &&
    (
      state.query.length > 0 ||
      state.filter !== "all" ||
      !noContent
    )
  );

  $("#visibleCount").textContent =
    `(${visible.length})`;

  $$(".filter-chip").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.filter === state.filter
    );
  });

  $$(".side-nav [data-filter]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.filter === state.filter
    );
  });

  $$('.nav-link[data-nav="all"]').forEach(button => {
    button.classList.toggle(
      "active",
      state.filter === "all"
    );
  });

  $$("#contentGrid img").forEach(img => {
    img.addEventListener("error", () => {
      const placeholder = document.createElement("div");

      placeholder.className = "poster-placeholder";
      placeholder.textContent = "K.";

      img.replaceWith(placeholder);
    }, { once: true });
  });
}

/* =========================================================
   VERİLERİ YENİLE
   ========================================================= */

async function refreshData() {
  const data = await api("/api/bootstrap");

  state.user = data.user;
  state.items = data.items || [];

  render();

  if (
    $("#detailDialog").open &&
    state.activeDetailId
  ) {
    openDetails(state.activeDetailId);
  }
}

/* =========================================================
   İÇERİK EKLEME PENCERESİ
   ========================================================= */

function setSelectedKind(kind) {
  state.selectedKind = kind;

  $$(".type-option").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.kind === kind
    );
  });
}

function setAddMode(mode) {
  state.addMode = mode;

  $("#urlMode").hidden = mode !== "url";
  $("#manualMode").hidden = mode !== "manual";

  $$(".mode-tab").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.mode === mode
    );
  });

  $("#addError").textContent = "";
}

function resetAddForm() {
  $("#addForm").reset();

  $("#addError").textContent = "";

  $("#importPreview").hidden = true;
  $("#importPreview").innerHTML = "";

  state.imported = null;

  setAddMode("manual");
  setSelectedKind("movie");
}

function openAddDialog() {
  resetAddForm();
  openDialog("addDialog");
}

function renderImportPreview(metadata) {
  const preview = $("#importPreview");
  const image = safeImageUrl(metadata.posterUrl);

  preview.innerHTML = `
    ${
      image
        ? `<img src="${escapeHtml(image)}" alt="Afiş ön izlemesi" referrerpolicy="no-referrer">`
        : `<div class="preview-fallback">K.</div>`
    }

    <div class="preview-meta">
      <strong>${escapeHtml(metadata.title)}</strong>

      <span>
        ${metadata.kind === "movie" ? "Film" : "Dizi"}
        ${metadata.year ? ` · ${escapeHtml(metadata.year)}` : ""}
      </span>

      <p>
        ${escapeHtml(metadata.overview || "Açıklama bulunamadı.")}
      </p>
    </div>
  `;

  preview.hidden = false;

  const img = $("img", preview);

  if (img) {
    img.addEventListener("error", () => {
      const fallback = document.createElement("div");

      fallback.className = "preview-fallback";
      fallback.textContent = "K.";

      img.replaceWith(fallback);
    }, { once: true });
  }
}

async function importMetadata() {
  const button = $("#importBtn");
  const url = $("#sourceUrl").value.trim();

  $("#addError").textContent = "";

  if (!url) {
    $("#addError").textContent =
      "Önce bir TMDB veya IMDb bağlantısı gir.";

    return;
  }

  setBusy(button, true, "Getiriliyor…");

  try {
    const result = await api("/api/import", {
      method: "POST",
      body: { url }
    });

    state.imported = result.metadata;

    setSelectedKind(result.metadata.kind);
    renderImportPreview(result.metadata);

    showToast(
      "İçerik bilgileri bulundu. Arşivine ekleyebilirsin."
    );
  } catch (error) {
    $("#addError").textContent = error.message;
    state.imported = null;
    $("#importPreview").hidden = true;
  } finally {
    setBusy(button, false);
  }
}

/* =========================================================
   YENİ İÇERİĞİ KAYDET
   ========================================================= */

async function saveNewItem(event) {
  event.preventDefault();

  const button = $("#saveItemBtn");

  $("#addError").textContent = "";

  let payload;

  if (state.addMode === "url") {
    if (!state.imported) {
      $("#addError").textContent =
        "Önce bağlantıdan bilgileri getir veya Manuel ekle sekmesine geç.";

      return;
    }

    payload = {
      kind: state.selectedKind,
      title: state.imported.title,
      overview: state.imported.overview,
      year: state.imported.year,
      posterUrl: state.imported.posterUrl,
      sourceUrl: state.imported.sourceUrl
    };
  } else {
    const poster = $("#manualPoster").value.trim();

    if (poster && !safeImageUrl(poster)) {
      $("#addError").textContent =
        "Afiş bağlantısı https:// ile başlamalı.";

      return;
    }

    payload = {
      kind: state.selectedKind,
      title: $("#manualTitle").value.trim(),
      year: $("#manualYear").value.trim() || null,
      posterUrl: poster,
      overview: $("#manualOverview").value.trim()
    };

    if (!payload.title) {
      $("#addError").textContent =
        "İçerik adı boş bırakılamaz.";

      $("#manualTitle").focus();

      return;
    }
  }

  setBusy(button, true, "Ekleniyor…");

  try {
    await api("/api/items", {
      method: "POST",
      body: payload
    });

    closeDialog("addDialog");

    await refreshData();

    showToast(`${payload.title} arşivine eklendi.`);
  } catch (error) {
    $("#addError").textContent =
      error.message || "İçerik eklenemedi.";
  } finally {
    setBusy(button, false);
  }
}

/* =========================================================
   DETAY PENCERESİ
   ========================================================= */

function statusSelectMarkup(item) {
  return `
    <select
      class="status-select status-${escapeHtml(item.status)}"
      aria-label="İzleme durumunu değiştir"
      data-action="status"
      data-id="${escapeHtml(item.id)}"
    >
      <option value="planned" ${item.status === "planned" ? "selected" : ""}>İzlenecek</option>
      <option value="watching" ${item.status === "watching" ? "selected" : ""}>İzleniyor</option>
      <option value="done" ${item.status === "done" ? "selected" : ""}>Tamamlandı</option>
    </select>
  `;
}

function childEntryMarkup(child) {
  const descendants = childrenOf(child.id).sort(
    (a, b) =>
      String(a.created_at).localeCompare(String(b.created_at))
  );

  if (child.kind === "season") {
    const episodes = descendants.filter(
      entry => entry.kind === "episode"
    );

    return `
      <div class="child-entry">

        <div class="child-entry-top">
          <div>
            <span class="child-entry-kind">Sezon</span>
            <span class="child-entry-title">
              ${escapeHtml(child.title)}
            </span>
          </div>

          <button
            class="child-add-btn"
            type="button"
            data-action="add-episode"
            data-parent="${escapeHtml(child.id)}"
          >
            ＋ Bölüm
          </button>
        </div>

        ${
          child.overview
            ? `<p class="child-entry-note">${escapeHtml(child.overview)}</p>`
            : ""
        }

        <div class="nested-episodes">

          ${
            episodes.length
              ? episodes.map((episode, index) => `
                  <div class="episode-line">
                    <span>
                      ${String(index + 1).padStart(2, "0")}
                      · ${escapeHtml(episode.title)}
                    </span>

                    <span>${escapeHtml(formatStatus(episode.status))}</span>
                  </div>
                `).join("")
              : `
                  <div class="episode-line">
                    <span>Henüz bölüm eklenmedi.</span>
                    <span></span>
                  </div>
                `
          }

        </div>
      </div>
    `;
  }

  return `
    <div class="child-entry">

      <div class="child-entry-top">
        <div>
          <span class="child-entry-kind">Bölüm</span>
          <span class="child-entry-title">
            ${escapeHtml(child.title)}
          </span>
        </div>

        <span class="series-count">
          ${escapeHtml(formatStatus(child.status))}
        </span>
      </div>

      ${
        child.overview
          ? `<p class="child-entry-note">${escapeHtml(child.overview)}</p>`
          : ""
      }

    </div>
  `;
}

function openDetails(itemId) {
  const item = getItem(itemId);

  if (!item) return;

  state.activeDetailId = item.id;

  const image = safeImageUrl(item.poster_url);

  const childItems = childrenOf(item.id).sort(
    (a, b) =>
      String(a.created_at).localeCompare(String(b.created_at))
  );

  const isSeries = item.kind === "series";
  const isSeason = item.kind === "season";

  const progressContent = isSeries
    ? `
      <section class="watch-progress">

        <div>
          <span class="progress-kicker">KALDIĞIN YER</span>
          <strong>İzleme ilerlemen</strong>
          <p>Son kaldığın sezon ve bölümü kaydet.</p>
        </div>

        <div class="progress-fields">

          <label>
            Sezon
            <input
              id="progressSeason"
              class="field-input progress-input"
              type="number"
              min="1"
              max="999"
              value="${Number(item.progress_season) || 1}"
            >
          </label>

          <label>
            Bölüm
            <input
              id="progressEpisode"
              class="field-input progress-input"
              type="number"
              min="1"
              max="999"
              value="${Number(item.progress_episode) || 1}"
            >
          </label>

          <button
            class="button button-primary"
            id="saveProgressBtn"
            type="button"
            data-action="save-progress"
            data-id="${escapeHtml(item.id)}"
          >
            Kaydet
          </button>

        </div>
      </section>
    `
    : "";

  let bodyContent;

  if (isSeries || isSeason) {
    bodyContent = `
      ${progressContent}

      <div class="detail-subhead">

        <strong>
          ${isSeries ? "Sezonlar ve bölümler" : "Bölümler"}
        </strong>

        <div class="detail-actions">

          ${
            isSeries
              ? `
                <button
                  class="button button-secondary"
                  type="button"
                  data-action="add-season"
                  data-parent="${escapeHtml(item.id)}"
                >＋ Sezon</button>

                <button
                  class="button button-quiet"
                  type="button"
                  data-action="add-episode"
                  data-parent="${escapeHtml(item.id)}"
                >＋ Bölüm</button>
              `
              : `
                <button
                  class="button button-secondary"
                  type="button"
                  data-action="add-episode"
                  data-parent="${escapeHtml(item.id)}"
                >＋ Bölüm</button>
              `
          }

        </div>
      </div>

      <div class="child-list">

        ${
          childItems.length
            ? childItems.map(childEntryMarkup).join("")
            : `
              <div class="empty-child">
                Henüz alt içerik eklenmedi.
                İlk sezonunu veya bölümünü ekleyebilirsin.
              </div>
            `
        }

      </div>
    `;
  } else {
    bodyContent = `
      <div class="empty-child">
        Bu bir film. Tek başına arşivinde tutulur.
      </div>
    `;
  }

  $("#detailContent").innerHTML = `
    <div class="detail-head">

      <div class="detail-poster">

        ${
          image
            ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.title)} afişi" referrerpolicy="no-referrer">`
            : `<div class="poster-placeholder">K.</div>`
        }

      </div>

      <div class="detail-head-copy">

        <div class="eyebrow">
          ${formatKind(item.kind)}
          ${item.release_year ? ` · ${escapeHtml(item.release_year)}` : ""}
        </div>

        <h2>${escapeHtml(item.title)}</h2>

        <p>
          ${escapeHtml(item.overview || "Bu içerik için henüz bir açıklama eklenmemiş.")}
        </p>

      </div>

      <button
        class="icon-button detail-close"
        type="button"
        data-close="detailDialog"
        aria-label="Kapat"
      >×</button>

    </div>

    <div class="detail-body">

      <div class="detail-toolbar">
        <span>İZLEME DURUMU</span>
        ${statusSelectMarkup(item)}
      </div>

      ${bodyContent}

      <div class="detail-foot">

        <button
          class="delete-link"
          type="button"
          data-action="delete-item"
          data-id="${escapeHtml(item.id)}"
        >
          İçeriği ve alt öğelerini sil
        </button>

        ${
          item.source_url
            ? `<a class="source-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">Kaynak bağlantısı ↗</a>`
            : `<span class="series-count">KARE ARŞİVİ</span>`
        }

      </div>

    </div>
  `;

  const detailImage = $(".detail-poster img");

  if (detailImage) {
    detailImage.addEventListener("error", () => {
      const placeholder = document.createElement("div");

      placeholder.className = "poster-placeholder";
      placeholder.textContent = "K.";

      detailImage.replaceWith(placeholder);
    }, { once: true });
  }

  openDialog("detailDialog");
}

/* =========================================================
   SEZON VE BÖLÜM EKLEME
   ========================================================= */

function openChildDialog(parentId, kind) {
  const parent = getItem(parentId);

  if (!parent) return;

  $("#childForm").reset();
  $("#childError").textContent = "";

  $("#childParentId").value = parentId;
  $("#childKind").value = kind;

  if (kind === "season") {
    $("#childEyebrow").textContent =
      "DİZİNE YENİ SEZON EKLE";

    $("#childTitle").innerHTML =
      'Yeni sezon<span class="accent-dot">.</span>';

    $("#childNameLabel").textContent = "Sezon adı";
    $("#childName").placeholder = "Örn. 1. Sezon";
  } else {
    $("#childEyebrow").textContent =
      parent.kind === "season"
        ? "SEZONA YENİ BÖLÜM EKLE"
        : "DİZİNE YENİ BÖLÜM EKLE";

    $("#childTitle").innerHTML =
      'Yeni bölüm<span class="accent-dot">.</span>';

    $("#childNameLabel").textContent = "Bölüm adı";
    $("#childName").placeholder = "Örn. Bölüm 1 · Pilot";
  }

  openDialog("childDialog");

  window.setTimeout(() => {
    $("#childName").focus();
  }, 100);
}

async function saveChild(event) {
  event.preventDefault();

  const parentId = $("#childParentId").value;
  const kind = $("#childKind").value;
  const title = $("#childName").value.trim();

  const button = $('#childForm button[type="submit"]');

  $("#childError").textContent = "";

  if (!title) {
    $("#childError").textContent =
      "Bir isim girmen gerekiyor.";

    return;
  }

  setBusy(button, true, "Kaydediliyor…");

  try {
    await api(
      `/api/items/${encodeURIComponent(parentId)}/children`,
      {
        method: "POST",
        body: {
          kind,
          title,
          overview: $("#childOverview").value.trim()
        }
      }
    );

    closeDialog("childDialog");

    await refreshData();

    if (state.activeDetailId) {
      openDetails(state.activeDetailId);
    }

    showToast(
      `${kind === "season" ? "Sezon" : "Bölüm"} eklendi.`
    );
  } catch (error) {
    $("#childError").textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

/* =========================================================
   HESAP PENCERESİ
   ========================================================= */

function setAuthMode(mode) {
  state.authMode = mode;

  const register = mode === "register";

  $$(".auth-tab").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.authMode === mode
    );
  });

  $("#authEyebrow").textContent = register
    ? "KİŞİSEL ARŞİVİNİ KORU"
    : "KARE ARŞİVİNE DÖN";

  $("#authTitle").innerHTML = register
    ? 'Hikâyelerin<br><span>sana özel kalsın.</span>'
    : 'Güzel hikâyelere<br><span>kaldığın yerden.</span>';

  $("#authCopy").textContent = register
    ? "Hesap oluştur, koleksiyonunu farklı cihazlarda senkronize et."
    : "Hesabına giriş yap ve kişisel arşivine kaldığın yerden devam et.";

  $("#authSubmit").innerHTML = register
    ? "Ücretsiz hesap oluştur <span>↗</span>"
    : "Giriş yap <span>↗</span>";

  $("#authPassword").autocomplete = register
    ? "new-password"
    : "current-password";

  $("#authPassword").placeholder = register
    ? "En az 10 karakter"
    : "Şifren";

  $("#passwordHint").textContent = register
    ? "En az 10 karakter kullan. Misafir listen hesabına aktarılır."
    : "Giriş bilgilerin güvenli oturumla korunur.";

  $("#authError").textContent = "";
}

function openAuth(mode = "register") {
  $("#authForm").reset();

  setAuthMode(mode);

  openDialog("authDialog");
}

async function submitAuth(event) {
  event.preventDefault();

  const button = $("#authSubmit");

  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;

  $("#authError").textContent = "";

  if (state.authMode === "register" && password.length < 10) {
    $("#authError").textContent =
      "Şifre en az 10 karakter olmalı.";

    return;
  }

  setBusy(button, true, "Kontrol ediliyor…");

  try {
    const endpoint =
      state.authMode === "register"
        ? "/api/register"
        : "/api/login";

    const result = await api(endpoint, {
      method: "POST",
      body: {
        email,
        password
      }
    });

    state.user = result.user;

    closeDialog("authDialog");

    await refreshData();

    showToast(result.message || "Oturum açıldı.");
  } catch (error) {
    $("#authError").textContent =
      error.message || "Hesap işlemi başarısız.";
  } finally {
    setBusy(button, false);
  }
}

async function logout() {
  if (!window.confirm("Oturumu kapatmak istiyor musun?")) {
    return;
  }

  try {
    await api("/api/logout", {
      method: "POST"
    });

    await refreshData();

    showToast(
      "Oturum kapatıldı. Misafir olarak devam edebilirsin."
    );
  } catch (error) {
    showToast(error.message, "error");
  }
}

/* =========================================================
   İZLEME DURUMU
   ========================================================= */

async function updateStatus(itemId, status, select) {
  try {
    await api(
      `/api/items/${encodeURIComponent(itemId)}`,
      {
        method: "PATCH",
        body: { status }
      }
    );

    const item = getItem(itemId);

    if (item) {
      item.status = status;
    }

    if (select) {
      select.className = `status-select status-${status}`;
    }

    render();

    if (
      state.activeDetailId &&
      $("#detailDialog").open
    ) {
      openDetails(state.activeDetailId);
    }

    showToast(
      `Durum güncellendi: ${formatStatus(status)}.`
    );
  } catch (error) {
    showToast(error.message, "error");
    await refreshData();
  }
}

/* =========================================================
   DİZİ İLERLEMESİ
   ========================================================= */

async function saveProgress(itemId) {
  const season = Number($("#progressSeason")?.value);
  const episode = Number($("#progressEpisode")?.value);

  const button = $("#saveProgressBtn");

  if (
    !Number.isInteger(season) ||
    season < 1 ||
    season > 999 ||
    !Number.isInteger(episode) ||
    episode < 1 ||
    episode > 999
  ) {
    showToast(
      "Sezon ve bölüm numarası 1–999 arasında olmalı.",
      "error"
    );

    return;
  }

  setBusy(button, true, "Kaydediliyor…");

  try {
    await api(
      `/api/items/${encodeURIComponent(itemId)}`,
      {
        method: "PATCH",
        body: {
          progressSeason: season,
          progressEpisode: episode
        }
      }
    );

    const item = getItem(itemId);

    if (item) {
      item.progress_season = season;
      item.progress_episode = episode;
    }

    render();

    openDetails(itemId);

    showToast(
      `İlerleme kaydedildi: ${season}. sezon, ${episode}. bölüm.`
    );
  } catch (error) {
    showToast(error.message, "error");
    setBusy(button, false);
  }
}

/* =========================================================
   İÇERİK SİL
   ========================================================= */

async function deleteItem(itemId) {
  const item = getItem(itemId);

  if (!item) return;

  if (
    !window.confirm(
      `“${item.title}” ve alt içerikleri arşivinden silinsin mi?`
    )
  ) {
    return;
  }

  try {
    await api(
      `/api/items/${encodeURIComponent(itemId)}`,
      {
        method: "DELETE"
      }
    );

    closeDialog("detailDialog");

    state.activeDetailId = null;

    await refreshData();

    showToast("İçerik arşivinden silindi.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

/* =========================================================
   TÜM BUTON VE OLAYLAR
   ========================================================= */

function bindEvents() {
  // İÇERİK EKLEME PENCERESİ
  $("#openAddBtn").addEventListener("click", openAddDialog);
  $("#welcomeAddBtn").addEventListener("click", openAddDialog);
  $("#emptyAddBtn").addEventListener("click", openAddDialog);

  // FİLM / DİZİ SEÇİMİ
  $$(".type-option").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setSelectedKind(button.dataset.kind);
    });
  });

  // MANUEL / BAĞLANTI SEÇİMİ
  $$(".mode-tab").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setAddMode(button.dataset.mode);
    });
  });

  // TÜM KAPATMA VE VAZGEÇ BUTONLARI
  $$("[data-close]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(button.dataset.close);
    });
  });

  // FORMLAR
  $("#addForm").addEventListener("submit", saveNewItem);
  $("#importBtn").addEventListener("click", importMetadata);
  $("#childForm").addEventListener("submit", saveChild);
  $("#authForm").addEventListener("submit", submitAuth);

  // HESAP
  $("#sidebarAuthBtn").addEventListener("click", () => {
    openAuth("register");
  });

  $("#accountAction").addEventListener("click", () => {
    if (state.user) {
      logout();
    } else {
      openAuth("register");
    }
  });

  // GİRİŞ / KAYIT SEKМELERİ
  $$(".auth-tab").forEach(button => {
    button.addEventListener("click", () => {
      setAuthMode(button.dataset.authMode);
    });
  });

  // ARAMA
  $("#searchInput").addEventListener("input", event => {
    state.query = event.target.value.trim();
    render();
  });

  // SIRALAMA
  $("#sortBtn").addEventListener("click", () => {
    state.newestFirst = !state.newestFirst;
    render();
  });

  // FİLTRELER
  $$("[data-filter]").forEach(button => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      render();
    });
  });

  // DİĞER İŞLEMLER
  document.addEventListener("click", event => {
    const action = event.target.closest("[data-action]");
    if (!action) return;

    if (action.dataset.action === "details") {
      openDetails(action.dataset.id);
    }

    if (action.dataset.action === "add-season") {
      openChildDialog(action.dataset.parent, "season");
    }

    if (action.dataset.action === "add-episode") {
      openChildDialog(action.dataset.parent, "episode");
    }

    if (action.dataset.action === "delete-item") {
      deleteItem(action.dataset.id);
    }

    if (action.dataset.action === "save-progress") {
      saveProgress(action.dataset.id);
    }
  });

  // İZLEME DURUMU
  document.addEventListener("change", event => {
    const select = event.target.closest(
      'select[data-action="status"]'
    );

    if (select) {
      updateStatus(select.dataset.id, select.value, select);
    }
  });

  // KART KLAVYE DESTEĞİ
  document.addEventListener("keydown", event => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "k"
    ) {
      event.preventDefault();
      $("#searchInput").focus();
    }

    if (
      event.key === "Enter" &&
      event.target.matches('.card-poster[role="button"]')
    ) {
      openDetails(event.target.dataset.id);
    }
  });

  // PENCERE DIŞINA DOKUNUNCA KAPAT
  dialogs.forEach(id => {
    const dialog = document.getElementById(id);

    if (!dialog) return;

    dialog.addEventListener("click", event => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
  });
}
 /* KLAVYE KISAYOLLARI */

  document.addEventListener("keydown", event => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "k"
    ) {
      event.preventDefault();
      $("#searchInput").focus();
    }

    if (
      event.key === "Enter" &&
      event.target.matches('.card-poster[role="button"]')
    ) {
      openDetails(event.target.dataset.id);
    }
  });

  /* PENCERE DIŞINA DOKUNUNCA KAPAT */

  dialogs.forEach(id => {
    const dialog = document.getElementById(id);

    if (!dialog) return;

    dialog.addEventListener("click", event => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
  });
}

/* =========================================================
   UYGULAMAYI BAŞLAT
   ========================================================= */

async function init() {
  try {
    bindEvents();

    await refreshData();

    if (!isSupabaseReady()) {
      console.warn(
        "Supabase bulunamadı. KARE misafir modunda çalışıyor."
      );
    }

    /* 30 saniyede bir arşivi yenile */

    window.setInterval(() => {
      if (!document.hidden) {
        refreshData().catch(error => {
          console.error("Yenileme hatası:", error);
        });
      }
    }, 30000);

    document.addEventListener(
      "visibilitychange",
      () => {
        if (!document.hidden) {
          refreshData().catch(() => {});
        }
      }
    );

  } catch (error) {
    console.error("KARE başlatma hatası:", error);

    showToast(
      error.message || "Uygulama başlatılamadı.",
      "error"
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
