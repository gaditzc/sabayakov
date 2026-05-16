const TARGET_LOCATION = {
  lat: 31.762,
  lon: 35.203,
};

const GRAPH_SAMPLE_INTERVAL_MS = 1000;
const MAX_GRAPH_POINTS = 60;

let latestDistanceMeters = null;
let distanceChart = null;
let chartIntervalId = null;
let watchId = null;

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) {
    return "--";
  }

  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }

  const km = distanceMeters / 1000;
  const decimals = km < 10 ? 2 : 1;
  return `${km.toFixed(decimals)} km`;
}

function setStatus(message, isError) {
  const statusEl = document.getElementById("distance-status");
  if (!statusEl) {
    return;
  }

  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function setDistance(text) {
  const distanceEl = document.getElementById("distance-value");
  if (!distanceEl) {
    return;
  }

  distanceEl.textContent = text;
}

function setTrackingButtonState(text, disabled) {
  const buttonEl = document.getElementById("start-tracking-btn");
  if (!buttonEl) {
    return;
  }

  buttonEl.textContent = text;
  buttonEl.disabled = Boolean(disabled);
}

function formatTimeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function createDistanceChart() {
  const chartCanvas = document.getElementById("distance-chart");
  if (!chartCanvas || typeof Chart === "undefined") {
    return;
  }

  const chartContext = chartCanvas.getContext("2d");
  if (!chartContext) {
    return;
  }

  distanceChart = new Chart(chartContext, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Distance (m)",
          data: [],
          borderColor: "#0ea5e9",
          backgroundColor: "rgba(14, 165, 233, 0.18)",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.3,
          fill: true,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          intersect: false,
          mode: "index",
          callbacks: {
            label: function (context) {
              const value = context.parsed.y;
              return Number.isFinite(value) ? `Distance: ${Math.round(value)} m` : "No GPS data";
            },
          },
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: "Time",
          },
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 5,
          },
          grid: {
            color: "rgba(148, 163, 184, 0.25)",
          },
        },
        y: {
          title: {
            display: true,
            text: "Distance to Target (m)",
          },
          beginAtZero: true,
          grid: {
            color: "rgba(148, 163, 184, 0.2)",
          },
        },
      },
    },
  });
}

function sampleDistanceForGraph() {
  if (!distanceChart) {
    return;
  }

  const label = formatTimeLabel(Date.now());
  const value = Number.isFinite(latestDistanceMeters) ? latestDistanceMeters : null;

  distanceChart.data.labels.push(label);
  distanceChart.data.datasets[0].data.push(value);

  if (distanceChart.data.labels.length > MAX_GRAPH_POINTS) {
    distanceChart.data.labels.shift();
    distanceChart.data.datasets[0].data.shift();
  }

  distanceChart.update("none");
}

function updateFromPosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const distanceMeters = haversineDistanceMeters(
    latitude,
    longitude,
    TARGET_LOCATION.lat,
    TARGET_LOCATION.lon,
  );

  latestDistanceMeters = distanceMeters;
  setDistance(formatDistance(distanceMeters));

  const accuracyText = Number.isFinite(accuracy)
    ? ` (accuracy +- ${Math.round(accuracy)} m)`
    : "";
  setStatus(`GPS tracking is live${accuracyText}.`, false);
}

function handleLocationError(error) {
  latestDistanceMeters = null;
  setDistance("--");
  setTrackingButtonState("Start GPS Tracking", false);

  if (!window.isSecureContext) {
    setStatus("Location requires HTTPS. Please open the app from your GitHub Pages URL.", true);
    return;
  }

  if (error && error.code === error.PERMISSION_DENIED) {
    setStatus(
      "Location access is off. Please enable Location Services in browser settings, then tap Start again.",
      true,
    );
    return;
  }

  setStatus(
    "Unable to get your location right now. Move outdoors or check GPS, then tap Start again.",
    true,
  );
}

function requestSingleLocation() {
  navigator.geolocation.getCurrentPosition(updateFromPosition, handleLocationError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 12000,
  });
}

function startGeolocationWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  watchId = navigator.geolocation.watchPosition(updateFromPosition, handleLocationError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000,
  });
}

function startDistanceTracking() {
  createDistanceChart();

  sampleDistanceForGraph();
  if (chartIntervalId === null) {
    chartIntervalId = setInterval(sampleDistanceForGraph, GRAPH_SAMPLE_INTERVAL_MS);
  }

  if (!("geolocation" in navigator)) {
    latestDistanceMeters = null;
    setDistance("--");
    setStatus(
      "Location Services are not available on this device. Please use a modern browser.",
      true,
    );
    setTrackingButtonState("GPS Not Supported", true);
    return;
  }

  setTrackingButtonState("Start GPS Tracking", false);

  const startButton = document.getElementById("start-tracking-btn");
  if (!startButton) {
    return;
  }

  startButton.addEventListener("click", function () {
    setTrackingButtonState("Tracking Enabled", true);
    setStatus("Requesting your location permission...", false);
    requestSingleLocation();
    startGeolocationWatch();
  });
}

window.addEventListener("DOMContentLoaded", startDistanceTracking);
