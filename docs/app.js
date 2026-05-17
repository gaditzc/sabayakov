const CONFIG_URL = "./config.json";
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
let uiTickId = null;
let configLoadError = "";

function loadSavedState() {
  try {
    const rawState = localStorage.getItem(STORAGE_KEY);
    if (!rawState) {
      return {
        screen: APP_STATE.LOGIN,
        activeStationId: null,
        navigationStartTimestamp: null,
      };
    }

    const parsed = JSON.parse(rawState);
    return {
      screen: typeof parsed.screen === "string" ? parsed.screen : APP_STATE.LOGIN,
      activeStationId: Number.isFinite(parsed.activeStationId) ? parsed.activeStationId : null,
      navigationStartTimestamp: Number.isFinite(parsed.navigationStartTimestamp)
        ? parsed.navigationStartTimestamp
        : null,
    };
  } catch (error) {
    return {
      screen: APP_STATE.LOGIN,
      activeStationId: null,
      navigationStartTimestamp: null,
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

  const stations = rawConfig.stations.map(function (station, index) {
    const requiredStringFields = ["clue_text", "arrival_code", "mission_text", "completion_code"];
    requiredStringFields.forEach(function (field) {
      if (typeof station[field] !== "string" || !station[field].length) {
        throw new Error(`Station ${index + 1} is missing ${field}.`);
      }
    });

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
      arrival_code: station.arrival_code,
      mission_text: station.mission_text,
      completion_code: station.completion_code,
    };
  });

  return {
    login_password: rawConfig.login_password,
    stations: stations,
  };
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

function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

function setTimerValue(value) {
  setText("timer-value", value);
}

function setFormError(id, message) {
  setText(id, message);
}

function clearLiveTimers() {
  if (uiTickId !== null) {
    window.clearInterval(uiTickId);
    uiTickId = null;
  }
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
          "Location Services are disabled. Please enable them in your browser settings.",
          true,
        );
        return;
      }

      setLiveStatus(
        "We could not read your location right now. Please check Location Services.",
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

  if (Number.isFinite(appState.navigationStartTimestamp)) {
    setTimerValue(formatElapsedTime(Date.now() - appState.navigationStartTimestamp));
  } else {
    setTimerValue("00:00");
  }

  if (currentCoords) {
    const distanceMeters = haversineDistanceMeters(
      currentCoords.latitude,
      currentCoords.longitude,
      station.target_lat,
      station.target_lon,
    );
    setDistanceValue(formatDistanceMeters(distanceMeters));
    if (!document.getElementById("distance-status")?.classList.contains("is-error")) {
      setLiveStatus("Live GPS tracking is active.", false);
    }
  } else {
    setDistanceValue("--");
    if (!document.getElementById("distance-status")?.textContent) {
      setLiveStatus("Waiting for GPS signal...", false);
    }
  }
}

function startLiveUpdates() {
  clearLiveTimers();
  uiTickId = window.setInterval(updateLiveHeader, 1000);
  updateLiveHeader();
  startGeolocationTracking();
}

function renderLoadingScreen() {
  appRoot.innerHTML = `
    <section class="screen screen--centered">
      <div class="panel panel--compact">
        <p class="eyebrow">The Amazing Race</p>
        <h1 class="hero-title">Loading game data…</h1>
        <p class="body-copy">Preparing your stations and race settings.</p>
      </div>
    </section>
  `;
}

function renderConfigErrorScreen() {
  appRoot.innerHTML = `
    <section class="screen screen--centered">
      <div class="panel panel--compact">
        <p class="eyebrow">The Amazing Race</p>
        <h1 class="hero-title">Unable to load the game</h1>
        <p class="body-copy">${escapeHtml(configLoadError || "The configuration file could not be read.")}</p>
      </div>
    </section>
  `;
}

function renderLoginScreen() {
  appRoot.innerHTML = `
    <section class="screen screen--centered">
      <form id="login-form" class="panel login-panel" novalidate>
        <div class="login-icon" aria-hidden="true">☎</div>
        <p class="eyebrow">Entry Screen</p>
        <h1 class="hero-title">Welcome to The Amazing Race</h1>
        <p class="body-copy">Enter Dad&apos;s phone number to start the game.</p>
        <label class="field-label" for="login-password">Password</label>
        <input
          id="login-password"
          name="login-password"
          class="text-input"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          placeholder="Phone number"
          required
        />
        <p id="login-error" class="field-error" role="alert"></p>
        <button class="primary-button" type="submit">Enter Game</button>
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
      navigationStartTimestamp: null,
    };
    saveState();
    render();
    return;
  }

  const isNavigation = appState.screen === APP_STATE.NAVIGATION;
  const heading = isNavigation ? "Navigation Mode" : "Mission Mode";
  const copy = isNavigation ? station.clue_text : station.mission_text;
  const label = isNavigation ? "Arrival Passcode" : "Completion Passcode";
  const inputId = isNavigation ? "arrival-passcode" : "completion-passcode";
  const formId = isNavigation ? "arrival-form" : "completion-form";
  const errorId = isNavigation ? "arrival-error" : "completion-error";
  const buttonText = isNavigation ? "Confirm Arrival" : "Submit Completion Code";

  appRoot.innerHTML = `
    <section class="screen screen--game">
      <header class="game-header" aria-label="Live navigation status">
        <div class="metric-card">
          <span class="metric-label">Elapsed Time</span>
          <span id="timer-value" class="metric-value">00:00</span>
        </div>
        <div class="metric-card">
          <div class="metric-label-row">
            <span class="live-dot" aria-hidden="true"></span>
            <span class="metric-label">Distance Remaining</span>
          </div>
          <span id="distance-value" class="metric-value">--</span>
          <span id="distance-status" class="metric-subtle">Waiting for GPS signal...</span>
        </div>
      </header>

      <section class="panel story-panel" aria-live="polite">
        <p class="eyebrow">${heading}</p>
        <p class="story-text">${escapeHtml(copy)}</p>
      </section>

      <form id="${formId}" class="panel action-panel" novalidate>
        <label class="field-label" for="${inputId}">${label}</label>
        <input
          id="${inputId}"
          name="code"
          class="text-input"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="Enter code"
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
        <p class="eyebrow">Game Completed</p>
        <h1 class="hero-title">Congratulations!</h1>
        <p class="body-copy">You finished The Amazing Race.</p>
      </div>
    </section>
  `;
}

function render() {
  if (!appRoot) {
    return;
  }

  stopGeolocationTracking();
  clearLiveTimers();

  if (!gameConfig) {
    if (configLoadError) {
      renderConfigErrorScreen();
    } else {
      renderLoadingScreen();
    }
    return;
  }

  if (appState.screen === APP_STATE.LOGIN) {
    renderLoginScreen();
    return;
  }

  if (appState.screen === APP_STATE.COMPLETED) {
    renderCompletedScreen();
    return;
  }

  renderGameScreen();
  startLiveUpdates();
}

function handleLoginSubmit(form) {
  const passwordValue = form.elements["login-password"].value.trim();
  if (passwordValue !== gameConfig.login_password) {
    setFormError("login-error", "Incorrect password.");
    return;
  }

  appState = {
    screen: APP_STATE.NAVIGATION,
    activeStationId: gameConfig.stations[0].station_id,
    navigationStartTimestamp: Date.now(),
  };
  saveState();
  currentCoords = null;
  render();
}

function handleArrivalSubmit(form) {
  const station = getCurrentStation();
  if (!station) {
    return;
  }

  const arrivalCode = form.elements.code.value.trim().toUpperCase();
  if (arrivalCode !== station.arrival_code.toUpperCase()) {
    setFormError("arrival-error", "Incorrect arrival passcode.");
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
  const station = getCurrentStation();
  if (!station) {
    return;
  }

  const completionCode = form.elements.code.value.trim().toUpperCase();
  if (completionCode !== station.completion_code.toUpperCase()) {
    setFormError("completion-error", "Incorrect completion passcode.");
    return;
  }

  const currentStationIndex = getStationIndex(station.station_id);
  const isFinalStation = currentStationIndex === gameConfig.stations.length - 1;

  if (isFinalStation) {
    appState = {
      screen: APP_STATE.COMPLETED,
      activeStationId: station.station_id,
      navigationStartTimestamp: appState.navigationStartTimestamp,
    };
    saveState();
    render();
    return;
  }

  const nextStation = gameConfig.stations[currentStationIndex + 1];
  appState = {
    screen: APP_STATE.NAVIGATION,
    activeStationId: nextStation.station_id,
    navigationStartTimestamp: Date.now(),
  };
  saveState();
  currentCoords = null;
  render();
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

  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY || !event.newValue) {
      return;
    }

    try {
      const nextState = JSON.parse(event.newValue);
      appState = {
        screen: typeof nextState.screen === "string" ? nextState.screen : APP_STATE.LOGIN,
        activeStationId: Number.isFinite(nextState.activeStationId) ? nextState.activeStationId : null,
        navigationStartTimestamp: Number.isFinite(nextState.navigationStartTimestamp)
          ? nextState.navigationStartTimestamp
          : null,
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
    configLoadError = "The game configuration file could not be loaded.";
    render();
    return;
  }

  if (appState.screen !== APP_STATE.LOGIN && appState.screen !== APP_STATE.COMPLETED) {
    const restoredStation = getStationById(appState.activeStationId);
    if (!restoredStation) {
      appState = {
        screen: APP_STATE.LOGIN,
        activeStationId: null,
        navigationStartTimestamp: null,
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
