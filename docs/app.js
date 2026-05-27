const CONFIG_URL = "./config.json?t=" + Date.now();
const STORAGE_KEY = "amazing-race-game-state-v1";

const APP_STATE = {
  LOADING: "loading",
  LOGIN: "login",
  NAVIGATION: "navigation",
  MISSION: "mission",
  COMPLETED: "completed",
  ERROR: "error",
};

const appRoot = document.getElementById("app");

let gameConfig = null;
let appState = loadSavedState();
let currentCoords = null;
let geolocationWatchId = null;
let configLoadError = "";

function loadSavedState() {
  try {
    const rawState = localStorage.getItem(STORAGE_KEY);
    if (!rawState) {
      return {
        screen: APP_STATE.LOGIN,
        activeStationId: null,
      };
    }

    const parsed = JSON.parse(rawState);
    return {
      screen: typeof parsed.screen === "string" ? parsed.screen : APP_STATE.LOGIN,
      activeStationId: Number.isFinite(parsed.activeStationId) ? parsed.activeStationId : null,
    };
  } catch (error) {
    return {
      screen: APP_STATE.LOGIN,
      activeStationId: null,
    };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function setState(nextState) {
  appState = {
    ...appState,
    ...nextState,
  };
  saveState();
  render();
}

function validateConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error("Invalid configuration file.");
  }

  if (typeof rawConfig.login_password !== "string" || !rawConfig.login_password.length) {
    throw new Error("Missing login password.");
  }

  if (!Array.isArray(rawConfig.stations) || rawConfig.stations.length === 0) {
    throw new Error("Missing stations.");
  }

  const arrivalDistanceThresholdMeters = rawConfig.arrival_distance_threshold_meters;

  if (!Number.isFinite(arrivalDistanceThresholdMeters) || arrivalDistanceThresholdMeters <= 0) {
    throw new Error("arrival_distance_threshold_meters must be a positive number.");
  }

  const stations = rawConfig.stations.map(function (station, index) {
    const requiredStringFields = ["clue_text", "arrival_code", "completion_code"];
    requiredStringFields.forEach(function (field) {
      if (typeof station[field] !== "string" || !station[field].length) {
        throw new Error(`Station ${index + 1} is missing ${field}.`);
      }
    });

    const hasMissionText = typeof station.mission_text === "string" && station.mission_text.length > 0;
    const hasMissionSteps = Array.isArray(station.mission_steps) && station.mission_steps.length > 0;

    if (!hasMissionText && !hasMissionSteps) {
      throw new Error(`Station ${index + 1} must include mission_text or mission_steps.`);
    }

    let missionSteps = null;
    if (hasMissionSteps) {
      missionSteps = station.mission_steps.map(function (step, stepIndex) {
        if (!step || typeof step !== "object") {
          throw new Error(`Station ${index + 1}, mission step ${stepIndex + 1} is invalid.`);
        }

        if (step.step_type !== "text" && step.step_type !== "video" && step.step_type !== "youtube") {
          throw new Error(`Station ${index + 1}, mission step ${stepIndex + 1} has unsupported step_type.`);
        }

        if (typeof step.content !== "string" || !step.content.length) {
          throw new Error(`Station ${index + 1}, mission step ${stepIndex + 1} is missing content.`);
        }

        return {
          step_type: step.step_type,
          content: step.content,
        };
      });
    }

    if (!Number.isFinite(station.station_id)) {
      throw new Error(`Station ${index + 1} is missing station_id.`);
    }

    if (!Number.isFinite(station.target_lat) || !Number.isFinite(station.target_lon)) {
      throw new Error(`Station ${index + 1} is missing coordinates.`);
    }

    return {
      station_id: station.station_id,
      target_lat: station.target_lat,
      target_lon: station.target_lon,
      clue_text: station.clue_text,
      clue_video: typeof station.clue_video === "string" ? station.clue_video : null,
      clue_logo: typeof station.clue_logo === "string" ? station.clue_logo : null,
      mission_image: typeof station.mission_image === "string" ? station.mission_image : null,
      arrival_code: station.arrival_code,
      mission_text: hasMissionText ? station.mission_text : "",
      mission_steps: missionSteps,
      completion_code: station.completion_code,
    };
  });

  return {
    login_password: rawConfig.login_password,
    arrival_distance_threshold_meters: arrivalDistanceThresholdMeters,
    stations: stations,
  };
}

function getArrivalDistanceThresholdMeters() {
  return gameConfig.arrival_distance_threshold_meters;
}

async function loadConfig() {
  const response = await fetch(CONFIG_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${CONFIG_URL}.`);
  }

  const rawConfig = await response.json();
  return validateConfig(rawConfig);
}

function getStationById(stationId) {
  if (!gameConfig || !Number.isFinite(stationId)) {
    return null;
  }

  return gameConfig.stations.find(function (station) {
    return station.station_id === stationId;
  }) || null;
}

function getCurrentStation() {
  return getStationById(appState.activeStationId);
}

function getStationIndex(stationId) {
  if (!gameConfig) {
    return -1;
  }

  return gameConfig.stations.findIndex(function (station) {
    return station.station_id === stationId;
  });
}

function isGameplayScreen(screen) {
  return screen === APP_STATE.NAVIGATION || screen === APP_STATE.MISSION;
}

function normalizeStationCode(value) {
  return String(value || "").trim().toUpperCase();
}

function getDestinationByCode(rawCode) {
  if (!gameConfig) {
    return null;
  }

  const code = normalizeStationCode(rawCode);
  if (!code) {
    return null;
  }

  for (let index = 0; index < gameConfig.stations.length; index += 1) {
    const station = gameConfig.stations[index];

    if (normalizeStationCode(station.arrival_code) === code) {
      return {
        screen: APP_STATE.MISSION,
        activeStationId: station.station_id,
      };
    }

    if (normalizeStationCode(station.completion_code) === code) {
      const isFinalStation = index === gameConfig.stations.length - 1;
      if (isFinalStation) {
        return {
          screen: APP_STATE.COMPLETED,
          activeStationId: station.station_id,
        };
      }

      return {
        screen: APP_STATE.NAVIGATION,
        activeStationId: gameConfig.stations[index + 1].station_id,
      };
    }
  }

  return null;
}

function jumpToStationByCode(rawCode) {
  const destination = getDestinationByCode(rawCode);
  if (!destination) {
    return false;
  }

  appState = {
    screen: destination.screen,
    activeStationId: destination.activeStationId,
  };
  saveState();
  currentCoords = null;
  render();
  return true;
}

function formatDistanceMeters(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) {
    return "--";
  }

  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }

  const kilometers = distanceMeters / 1000;
  const decimals = kilometers < 10 ? 2 : 1;
  return `${kilometers.toFixed(decimals)} km`;
}

function normalizePhoneLikeValue(value) {
  const latinDigits = String(value)
    .trim()
    .replace(/[\u0660-\u0669]/g, function (char) {
      return String(char.charCodeAt(0) - 0x0660);
    })
    .replace(/[\u06F0-\u06F9]/g, function (char) {
      return String(char.charCodeAt(0) - 0x06f0);
    });

  return latinDigits.replace(/[^0-9]/g, "");
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRadians = function (value) {
    return (value * Math.PI) / 180;
  };

  const earthRadiusMeters = 6371000;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLon / 2) *
      Math.sin(deltaLon / 2);

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTextWithClickableLinks(value) {
  const textValue = String(value || "");
  const parts = textValue.split(/(https?:\/\/[^\s]+)/g);

  const html = parts
    .map(function (part, index) {
      const isUrlPart = index % 2 === 1;
      if (!isUrlPart) {
        return escapeHtml(part);
      }

      const isImageUrl = /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(part);
      const escapedUrl = escapeHtml(part);
      if (isImageUrl) {
        return `<img class="inline-content-image" src="${escapedUrl}" alt="Clue image" loading="lazy" />`;
      }

      return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer">${escapedUrl}</a>`;
    })
    .join("");

  return html.replace(/\n/g, "<br />");
}

function isValidVideoUrl(value) {
  try {
    const parsedUrl = new URL(value, window.location.href);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function extractYouTubeId(value) {
  try {
    const parsedUrl = new URL(value, window.location.href);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (hostname === "youtu.be") {
      const shortId = parsedUrl.pathname.replace("/", "").trim();
      return shortId || null;
    }

    if (hostname.endsWith("youtube.com")) {
      if (parsedUrl.pathname === "/watch") {
        const watchId = parsedUrl.searchParams.get("v");
        return watchId || null;
      }

      if (parsedUrl.pathname.startsWith("/embed/")) {
        const embedId = parsedUrl.pathname.split("/")[2];
        return embedId || null;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

function getYouTubeEmbedUrl(value) {
  try {
    const parsedUrl = new URL(value, window.location.href);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (hostname.endsWith("youtube.com")) {
      const playlistId = parsedUrl.searchParams.get("list");
      if (parsedUrl.pathname === "/playlist" && playlistId) {
        return `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(playlistId)}`;
      }
    }
  } catch (error) {
    return null;
  }

  const id = extractYouTubeId(value);
  if (!id) {
    return null;
  }

  return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
}

function getStoryTextClass(value) {
  const textValue = String(value || "");
  const hasHebrew = /[\u0590-\u05FF]/.test(textValue);
  return hasHebrew ? "story-text story-text--rtl" : "story-text";
}

function renderMissionBody(station) {
  const missionImageMarkup = station.mission_image
    ? `<img src="${escapeHtml(station.mission_image)}" class="completion-photo" alt="" />`
    : "";
  if (Array.isArray(station.mission_steps) && station.mission_steps.length > 0) {
    const stepsMarkup = station.mission_steps
      .map(function (step) {
        if (step.step_type === "video" || step.step_type === "youtube") {
          const youtubeEmbedUrl = getYouTubeEmbedUrl(step.content);
          if (youtubeEmbedUrl) {
            const embedUrl = escapeHtml(youtubeEmbedUrl);
            return `
              <div class="mission-step mission-step--video mission-step--youtube">
                <div class="mission-youtube-wrap">
                  <iframe
                    class="mission-youtube"
                    src="${embedUrl}"
                    title="Mission video"
                    loading="lazy"
                    referrerpolicy="strict-origin-when-cross-origin"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen
                  ></iframe>
                </div>
              </div>
            `;
          }

          if (!isValidVideoUrl(step.content)) {
            return "";
          }

          const videoUrl = escapeHtml(step.content);
          return `
            <div class="mission-step mission-step--video">
              <video class="mission-video" controls playsinline preload="metadata">
                <source src="${videoUrl}" type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>
          `;
        }

        return `<p class="${getStoryTextClass(step.content)} mission-step mission-step--text">${formatTextWithClickableLinks(step.content)}</p>`;
      })
      .join("");

    return `${missionImageMarkup}<div class="mission-steps">${stepsMarkup}</div>`;
  }

  return `${missionImageMarkup}<p class="${getStoryTextClass(station.mission_text)}">${formatTextWithClickableLinks(station.mission_text)}</p>`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function setLiveStatus(message, isError) {
  setText("distance-status", message);
  const statusElement = document.getElementById("distance-status");
  if (statusElement) {
    statusElement.classList.toggle("is-error", Boolean(isError));
  }
}

function setDistanceValue(value) {
  setText("distance-value", value);
}

function setArrivalCodeWindow(visible, passcode) {
  const windowElement = document.getElementById("arrival-code-window");
  if (!windowElement) {
    return;
  }

  windowElement.classList.toggle("is-visible", Boolean(visible));
  const codeElement = document.getElementById("arrival-code-value");
  if (codeElement) {
    codeElement.textContent = visible ? passcode : "";
  }
}

function setFormError(id, message) {
  setText(id, message);
}

function stopGeolocationTracking() {
  if (geolocationWatchId !== null && "geolocation" in navigator) {
    navigator.geolocation.clearWatch(geolocationWatchId);
    geolocationWatchId = null;
  }
  currentCoords = null;
}

function startGeolocationTracking() {
  if (!("geolocation" in navigator) || geolocationWatchId !== null) {
    return;
  }

  geolocationWatchId = navigator.geolocation.watchPosition(
    function (position) {
      currentCoords = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      updateLiveHeader();
    },
    function (error) {
      currentCoords = null;
      if (error && error.code === error.PERMISSION_DENIED) {
        setLiveStatus(
          "שירותי המיקום כבויים. הפעילו אותם בהגדרות הדפדפן.",
          true,
        );
        return;
      }

      setLiveStatus(
        "לא הצלחנו לקרוא את המיקום כרגע. בדקו ששירותי המיקום פעילים.",
        true,
      );
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    },
  );
}

function updateLiveHeader() {
  if (!isGameplayScreen(appState.screen)) {
    return;
  }

  const station = getCurrentStation();
  if (!station) {
    return;
  }

  if (currentCoords) {
    const distanceMeters = haversineDistanceMeters(
      currentCoords.latitude,
      currentCoords.longitude,
      station.target_lat,
      station.target_lon,
    );
    const maxDistanceMeters = getArrivalDistanceThresholdMeters();
    setDistanceValue(formatDistanceMeters(distanceMeters));

    if (appState.screen === APP_STATE.NAVIGATION && distanceMeters <= maxDistanceMeters) {
      setLiveStatus(`אתם בטווח. קוד הגעה: ${station.arrival_code}`, false);
      setArrivalCodeWindow(true, station.arrival_code);
    } else if (!document.getElementById("distance-status")?.classList.contains("is-error")) {
      setLiveStatus("מעקב GPS פעיל.", false);
      setArrivalCodeWindow(false, "");
    }
  } else {
    setDistanceValue("--");
    setArrivalCodeWindow(false, "");
    if (!document.getElementById("distance-status")?.textContent) {
      setLiveStatus("ממתינים לאות GPS...", false);
    }
  }
}

function startLiveUpdates() {
  updateLiveHeader();
  startGeolocationTracking();
}

function renderLoadingScreen() {
  appRoot.innerHTML = `
    <section class="screen screen--centered">
      <div class="panel panel--compact">
        <p class="eyebrow">Sabayakov</p>
        <h1 class="hero-title">טוען את המשחק…</h1>
        <p class="body-copy">מכין את התחנות וההגדרות.</p>
      </div>
    </section>
  `;
}

function renderConfigErrorScreen() {
  appRoot.innerHTML = `
    <section class="screen screen--centered">
      <div class="panel panel--compact">
        <p class="eyebrow">Sabayakov</p>
        <h1 class="hero-title">לא ניתן לטעון את המשחק</h1>
        <p class="body-copy">${escapeHtml(configLoadError || "לא ניתן לקרוא את קובץ ההגדרות.")}</p>
      </div>
    </section>
  `;
}

function renderLoginScreen() {
  appRoot.innerHTML = `
    <section class="screen screen--centered">
      <form id="login-form" class="panel login-panel" novalidate>
        <div class="login-icon" aria-hidden="true">☎</div>
        <input
          id="login-password"
          name="login-password"
          class="text-input"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          placeholder=""
          required
        />
        <p id="login-error" class="field-error" role="alert"></p>
        <button type="submit" aria-label="אישור" style="display:none;">אישור</button>
      </form>
    </section>
  `;
}

function renderGameScreen() {
  const station = getCurrentStation();
  if (!station) {
    appState = {
      screen: APP_STATE.LOGIN,
      activeStationId: null,
    };
    saveState();
    render();
    return;
  }

  const isNavigation = appState.screen === APP_STATE.NAVIGATION;
  const inputId = isNavigation ? "arrival-passcode" : "completion-passcode";
  const formId = isNavigation ? "arrival-form" : "completion-form";
  const errorId = isNavigation ? "arrival-error" : "completion-error";
  const buttonText = "שלח";
  const clueVideoMarkup = isNavigation && station.clue_video
    ? `<video class="clue-video" src="${station.clue_video}" controls playsinline preload="metadata"></video>`
    : "";
  const clueTextMarkup = isNavigation && station.clue_logo
    ? `<div class="clue-link-row">
        <img src="${escapeHtml(station.clue_logo)}" class="clue-logo" alt="" />
        <span>${formatTextWithClickableLinks(station.clue_text)}</span>
      </div>`
    : `<p class="${getStoryTextClass(station.clue_text)}">${formatTextWithClickableLinks(station.clue_text)}</p>`;
  const storyMarkup = isNavigation
    ? `${clueVideoMarkup}${clueTextMarkup}`
    : renderMissionBody(station);

  appRoot.innerHTML = `
    <section class="screen screen--game">
      <header class="game-header" aria-label="Live navigation status">
        <div class="metric-card">
          <span class="metric-label">המרחק מנקודת הציון הבאה</span>
          <span id="distance-value" class="metric-value">--</span>
        </div>
      </header>

      <section class="panel story-panel" aria-live="polite">
        ${storyMarkup}
      </section>

      ${isNavigation
        ? `<section id="arrival-code-window" class="panel arrival-code-window" aria-live="polite">
            <p class="arrival-code-text">הקלידו את הקוד בשדה למטה:</p>
            <p id="arrival-code-value" class="arrival-code-value"></p>
          </section>`
        : ""}

      <form id="${formId}" class="panel action-panel" novalidate>
        <input
          id="${inputId}"
          name="code"
          class="text-input"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="הזינו קוד"
          required
        />
        <p id="${errorId}" class="field-error" role="alert"></p>
        <button class="primary-button" type="submit">${buttonText}</button>
      </form>
    </section>
  `;
}

function renderCompletedScreen() {
  appRoot.innerHTML = `
    <section class="screen screen--centered">
      <div class="panel panel--compact completion-panel">
        <div class="completion-badge" aria-hidden="true">🏁</div>
        <p class="eyebrow">המשחק הושלם</p>
        <h1 class="hero-title">כל הכבוד!</h1>
        <p class="body-copy">סיימתם את סביקוב.</p>
        <img src="./couple.png" alt="" class="completion-photo" />
      </div>
    </section>
  `;
}

function renderResetControl() {
  appRoot.insertAdjacentHTML(
    "beforeend",
    `
      <div class="reset-wrap">
        <button id="reset-progress-btn" class="reset-button" type="button">איפוס משחק</button>
      </div>
    `,
  );
}

function resetGameProgress() {
  localStorage.removeItem(STORAGE_KEY);
  appState = {
    screen: APP_STATE.LOGIN,
    activeStationId: null,
  };
  currentCoords = null;
  stopGeolocationTracking();
  render();
}

function render() {
  if (!appRoot) {
    return;
  }

  stopGeolocationTracking();

  if (!gameConfig) {
    if (configLoadError) {
      renderConfigErrorScreen();
    } else {
      renderLoadingScreen();
    }
    renderResetControl();
    return;
  }

  if (appState.screen === APP_STATE.LOGIN) {
    renderLoginScreen();
    renderResetControl();
    return;
  }

  if (appState.screen === APP_STATE.COMPLETED) {
    renderCompletedScreen();
    renderResetControl();
    return;
  }

  renderGameScreen();
  renderResetControl();
  startLiveUpdates();
}

function handleLoginSubmit(form) {
  const passwordValue = normalizePhoneLikeValue(form.elements["login-password"].value);
  const expectedPassword = normalizePhoneLikeValue(gameConfig.login_password);
  if (passwordValue !== expectedPassword) {
    setFormError("login-error", "סיסמה שגויה.");
    return;
  }

  appState = {
    screen: APP_STATE.NAVIGATION,
    activeStationId: gameConfig.stations[0].station_id,
  };
  saveState();
  currentCoords = null;
  render();
}

function handleArrivalSubmit(form) {
  const arrivalCode = normalizeStationCode(form.elements.code.value);
  if (jumpToStationByCode(arrivalCode)) {
    return;
  }

  const station = getCurrentStation();
  if (!station) {
    return;
  }

  if (!currentCoords) {
    setFormError("arrival-error", "קוד לא מוכר.");
    return;
  }

  const distanceMeters = haversineDistanceMeters(
    currentCoords.latitude,
    currentCoords.longitude,
    station.target_lat,
    station.target_lon,
  );
  const maxDistanceMeters = getArrivalDistanceThresholdMeters();

  if (distanceMeters > maxDistanceMeters) {
    setFormError("arrival-error", "קוד לא מוכר.");
    return;
  }

  if (arrivalCode !== normalizeStationCode(station.arrival_code)) {
    setFormError("arrival-error", "קוד לא מוכר.");
    return;
  }

  appState = {
    ...appState,
    screen: APP_STATE.MISSION,
  };
  saveState();
  render();
}

function handleCompletionSubmit(form) {
  const completionCode = normalizeStationCode(form.elements.code.value);
  if (jumpToStationByCode(completionCode)) {
    return;
  }

  setFormError("completion-error", "קוד לא מוכר.");
}

function bindEvents() {
  appRoot.addEventListener("submit", function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    event.preventDefault();

    if (form.id === "login-form") {
      handleLoginSubmit(form);
      return;
    }

    if (form.id === "arrival-form") {
      handleArrivalSubmit(form);
      return;
    }

    if (form.id === "completion-form") {
      handleCompletionSubmit(form);
    }
  });

  appRoot.addEventListener("input", function (event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    if (input.id === "login-password") {
      setFormError("login-error", "");
      return;
    }

    if (input.name === "code") {
      const errorId = input.closest("form")?.id === "arrival-form" ? "arrival-error" : "completion-error";
      setFormError(errorId, "");
    }
  });

  appRoot.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.id !== "reset-progress-btn") {
      return;
    }

    if (window.confirm("לאפס את כל ההתקדמות ולהתחיל מחדש?")) {
      resetGameProgress();
    }
  });

  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY || !event.newValue) {
      return;
    }

    try {
      const nextState = JSON.parse(event.newValue);
      appState = {
        screen: typeof nextState.screen === "string" ? nextState.screen : APP_STATE.LOGIN,
        activeStationId: Number.isFinite(nextState.activeStationId) ? nextState.activeStationId : null,
      };
      render();
    } catch (error) {
      // Ignore malformed storage updates.
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      updateLiveHeader();
    }
  });
}

async function init() {
  bindEvents();
  renderLoadingScreen();

  try {
    gameConfig = await loadConfig();
  } catch (error) {
    configLoadError = "לא ניתן לטעון את קובץ הגדרות המשחק.";
    render();
    return;
  }

  if (appState.screen !== APP_STATE.LOGIN && appState.screen !== APP_STATE.COMPLETED) {
    const restoredStation = getStationById(appState.activeStationId);
    if (!restoredStation) {
      appState = {
        screen: APP_STATE.LOGIN,
        activeStationId: null,
      };
      saveState();
    }
  }

  if (appState.screen === APP_STATE.COMPLETED && !getStationById(appState.activeStationId)) {
    appState = {
      ...appState,
      activeStationId: gameConfig.stations[gameConfig.stations.length - 1].station_id,
    };
    saveState();
  }

  render();
}

window.addEventListener("DOMContentLoaded", init);
