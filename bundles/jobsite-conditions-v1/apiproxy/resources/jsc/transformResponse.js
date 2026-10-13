// Maps the Open-Meteo payload to the jobsite-conditions contract and adds an
// operating advisory. Thresholds come from the jobsite-config KVM, with safe defaults.
// The advisory is illustrative; site safety procedures and equipment manuals take precedence.

var DEFAULT_THRESHOLDS = {
  windCautionKmh: 30,
  windRestrictedKmh: 50,
  gustRestrictedKmh: 60,
  precipitationCautionMm: 2,
  temperatureLowC: -20,
  temperatureHighC: 40
};

var LEVELS = ["NORMAL", "CAUTION", "RESTRICTED"];

function loadThresholds() {
  var raw = context.getVariable("jobsite.config.thresholds");
  var thresholds = {};
  var key;
  for (key in DEFAULT_THRESHOLDS) thresholds[key] = DEFAULT_THRESHOLDS[key];
  if (raw) {
    try {
      var overrides = JSON.parse(raw);
      for (key in overrides) if (typeof overrides[key] === "number") thresholds[key] = overrides[key];
    } catch (e) {
      print("Invalid advisory-thresholds KVM entry, using defaults: " + e);
    }
  }
  return thresholds;
}

function describeWeather(code) {
  if (code === 0) return "Clear sky";
  if (code >= 1 && code <= 3) return "Partly cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Unknown";
}

function buildAdvisory(c, t) {
  var level = 0;
  var reasons = [];

  function raise(newLevel, reason) {
    if (newLevel > level) level = newLevel;
    reasons.push(reason);
  }

  if (c.weatherCode >= 95) raise(2, "Thunderstorm: lightning risk, stop work in open areas");
  if (c.windSpeedKmh >= t.windRestrictedKmh || c.windGustKmh >= t.gustRestrictedKmh) {
    raise(2, "Wind above lifting limit: suspend crane and elevated work platform operations");
  } else if (c.windSpeedKmh >= t.windCautionKmh) {
    raise(1, "High wind: review load charts before lifting");
  }
  if (c.precipitationMm >= t.precipitationCautionMm) raise(1, "Heavy precipitation: reduced traction and ground stability");
  if (c.weatherCode === 45 || c.weatherCode === 48) raise(1, "Fog: reduced visibility, use spotters");
  if (c.temperatureC !== null && c.temperatureC <= t.temperatureLowC) raise(1, "Extreme cold: follow cold-start and hydraulic warm-up procedures");
  if (c.temperatureC !== null && c.temperatureC >= t.temperatureHighC) raise(1, "Extreme heat: monitor coolant temperature and operator heat stress");

  return { level: LEVELS[level], reasons: reasons };
}

function location(body) {
  return {
    latitude: body.latitude,
    longitude: body.longitude,
    elevationM: body.elevation,
    timezone: body.timezone
  };
}

function conditionsFrom(body, t) {
  var cur = body.current || {};
  var c = {
    temperatureC: cur.temperature_2m,
    windSpeedKmh: cur.wind_speed_10m,
    windGustKmh: cur.wind_gusts_10m,
    precipitationMm: cur.precipitation,
    weatherCode: cur.weather_code,
    weather: describeWeather(cur.weather_code)
  };
  return {
    location: location(body),
    observedAt: cur.time,
    conditions: c,
    operatingAdvisory: buildAdvisory(c, t),
    source: "open-meteo.com"
  };
}

function forecastFrom(body, t) {
  var d = body.daily || {};
  var days = [];
  var dates = d.time || [];
  for (var i = 0; i < dates.length; i++) {
    var c = {
      temperatureC: d.temperature_2m_max[i],
      temperatureMinC: d.temperature_2m_min[i],
      windSpeedKmh: d.wind_speed_10m_max[i],
      windGustKmh: d.wind_gusts_10m_max[i],
      precipitationMm: d.precipitation_sum[i],
      weatherCode: d.weather_code[i],
      weather: describeWeather(d.weather_code[i])
    };
    var advisory = buildAdvisory(c, t);
    days.push({
      date: dates[i],
      temperatureMaxC: c.temperatureC,
      temperatureMinC: c.temperatureMinC,
      windSpeedMaxKmh: c.windSpeedKmh,
      windGustMaxKmh: c.windGustKmh,
      precipitationMm: c.precipitationMm,
      weather: c.weather,
      operatingAdvisory: advisory
    });
  }
  return { location: location(body), days: days, source: "open-meteo.com" };
}

var body = JSON.parse(context.getVariable("response.content"));
var thresholds = loadThresholds();
var isForecast = context.getVariable("proxy.pathsuffix") === "/forecast";
var result = isForecast ? forecastFrom(body, thresholds) : conditionsFrom(body, thresholds);

context.setVariable("response.content", JSON.stringify(result));
context.setVariable("response.header.Content-Type", "application/json");
