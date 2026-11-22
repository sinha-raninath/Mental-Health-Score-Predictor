'use strict';

/* =========================================================
   Configuration
   ========================================================= */
const API_BASE_URL = 'https://mental-health-score-predictor-1-6lkg.onrender.com';
const REQUEST_TIMEOUT_MS = 20000;
const MIN_LOADING_MS = 500; // keeps the loading state readable when the API answers instantly

// Scale used to draw the gauge and pick a message. Adjust to match your model's target.
const SCORE_SCALE = { min: 1, max: 10 };
const SCORE_BANDS = [
  {
    below: 5,
    key: 'low',
    label: 'Lower range',
    message: 'The model expects a lower score for these answers. If this matches how things feel, talking with a counsellor or someone you trust can help.',
  },
  {
    below: 7,
    key: 'mid',
    label: 'Middle range',
    message: 'The model expects a score near the middle of the scale for these answers.',
  },
  {
    below: Infinity,
    key: 'high',
    label: 'Higher range',
    message: 'The model expects a higher score for these answers.',
  },
];

/* Mirrors the StudentData Pydantic model. Choice options are read from the HTML. */
const FIELDS = [
  { name: 'age', kind: 'int', min: 10, max: 100, empty: 'Enter an age.' },
  { name: 'gender', kind: 'choice', empty: 'Choose a gender.' },
  { name: 'country', kind: 'text', empty: 'Enter a country.' },
  { name: 'academic_level', kind: 'choice', empty: 'Choose an academic level.' },
  { name: 'most_used_platform', kind: 'choice', empty: 'Choose a platform.' },
  { name: 'purpose_of_use', kind: 'choice', empty: 'Choose a purpose.' },
  { name: 'avg_daily_usage_hours', kind: 'float', min: 0, max: 24, empty: 'Enter daily usage in hours.' },
  { name: 'daily_unlocks', kind: 'int', min: 0, empty: 'Enter the number of daily unlocks.' },
  { name: 'study_hours', kind: 'float', min: 0, max: 24, empty: 'Enter study hours.' },
  { name: 'physical_activity_hours', kind: 'float', min: 0, max: 24, empty: 'Enter physical activity hours.' },
  { name: 'sleep_hours_per_night', kind: 'float', min: 0, max: 24, empty: 'Enter sleep hours.' },
  { name: 'stress_level', kind: 'choice', empty: 'Choose a stress level.' },
];

const DAY_SEGMENTS = [
  { field: 'sleep_hours_per_night', key: 'sleep' },
  { field: 'avg_daily_usage_hours', key: 'social' },
  { field: 'study_hours', key: 'study' },
  { field: 'physical_activity_hours', key: 'move' },
];

const EXAMPLE_VALUES = {
  age: 21,
  gender: 'Female',
  country: 'India',
  academic_level: 'Undergraduate',
  most_used_platform: 'Instagram',
  purpose_of_use: 'Entertainment',
  avg_daily_usage_hours: 5.5,
  daily_unlocks: 80,
  study_hours: 4,
  physical_activity_hours: 1,
  sleep_hours_per_night: 6.5,
  stress_level: 'Medium',
};

/* =========================================================
   Element references and state
   ========================================================= */
const form = document.getElementById('predict-form');
const submitButton = document.getElementById('submit-button');
const submitLabel = document.getElementById('submit-label');
const resetButton = document.getElementById('reset-button');
const exampleButton = document.getElementById('example-button');
const retryButton = document.getElementById('retry-button');
const summary = document.getElementById('form-summary');

const card = document.getElementById('result-card');
const gaugeValue = document.getElementById('gauge-value');
const scoreValue = document.getElementById('score-value');
const scoreScale = document.getElementById('score-scale');
const gaugeMin = document.getElementById('gauge-min');
const gaugeMax = document.getElementById('gauge-max');
const bandLabel = document.getElementById('band-label');
const bandMessage = document.getElementById('band-message');
const errorTitle = document.getElementById('error-title');
const errorMessage = document.getElementById('error-message');
const statusRegion = document.getElementById('status');

const dayBar = document.getElementById('daybar');
const dayTrack = document.getElementById('daybar-track');
const dayTotal = document.getElementById('daybar-total');
const dayNote = document.getElementById('daybar-note');

const apiStatus = document.getElementById('api-status');
const apiStatusText = document.getElementById('api-status-text');

const fieldsByName = new Map(FIELDS.map((def) => [def.name, def]));
const dayFieldNames = new Set(DAY_SEGMENTS.map((segment) => segment.field));

let isSubmitting = false;
let countUpFrame = 0;

/* =========================================================
   Helpers
   ========================================================= */
class ApiError extends Error {
  constructor(kind, details = {}) {
    super(kind);
    this.name = 'ApiError';
    this.kind = kind; // network | timeout | validation | server | http | response
    this.status = details.status;
    this.detail = details.detail;
  }
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatHours = (value) => `${Number(value.toFixed(1))} h`;

/* =========================================================
   Validation (mirrors the Pydantic constraints)
   ========================================================= */
function getWrapper(name) {
  return form.querySelector(`[data-field="${name}"]`);
}

function readRaw(def) {
  return String(form.elements[def.name].value).trim();
}

function rangeMessage(def) {
  if (def.min !== undefined && def.max !== undefined) {
    return `Enter a value between ${def.min} and ${def.max}.`;
  }
  return `Enter ${def.min} or more.`;
}

function validateRaw(def) {
  const control = form.elements[def.name];
  const raw = readRaw(def);

  if (control.validity && control.validity.badInput) return 'Enter a valid number.';
  if (raw === '') return def.empty;
  if (def.kind === 'choice' || def.kind === 'text') return '';

  const number = Number(raw);
  if (!Number.isFinite(number)) return 'Enter a valid number.';
  if (def.kind === 'int' && !Number.isInteger(number)) return 'Use a whole number.';

  const belowMin = def.min !== undefined && number < def.min;
  const aboveMax = def.max !== undefined && number > def.max;
  return belowMin || aboveMax ? rangeMessage(def) : '';
}

function toPayloadValue(def) {
  const raw = readRaw(def);
  return def.kind === 'int' || def.kind === 'float' ? Number(raw) : raw;
}

function setFieldError(name, message) {
  const wrapper = getWrapper(name);
  const errorElement = document.getElementById(`${name}-error`);
  if (!wrapper || !errorElement) return;

  errorElement.textContent = message;
  wrapper.classList.toggle('is-invalid', Boolean(message));

  wrapper.querySelectorAll('input:not([type="radio"]), select').forEach((control) => {
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  });
}

function clearAllErrors() {
  FIELDS.forEach((def) => setFieldError(def.name, ''));
}

function validateSingle(def) {
  setFieldError(def.name, validateRaw(def));
}

function validateForm() {
  const payload = {};
  const invalid = [];

  FIELDS.forEach((def) => {
    const message = validateRaw(def);
    setFieldError(def.name, message);
    if (message) invalid.push(def.name);
    else payload[def.name] = toPayloadValue(def);
  });

  return { payload, invalid };
}

function focusField(name) {
  const control = form.elements[name];
  if (!control) return;
  const target = control instanceof RadioNodeList ? control[0] : control;
  target.focus();
}

function showSummary(count) {
  summary.textContent = count === 1
    ? 'Fix 1 field before predicting.'
    : `Fix ${count} fields before predicting.`;
  summary.hidden = false;
}

function hideSummary() {
  summary.hidden = true;
  summary.textContent = '';
}

/* =========================================================
   Day bar
   ========================================================= */
function updateDayBar() {
  const hours = DAY_SEGMENTS.map((segment) => {
    const value = Number(form.elements[segment.field].value);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });

  const total = hours.reduce((sum, value) => sum + value, 0);
  const scale = total > 24 ? 24 / total : 1;

  DAY_SEGMENTS.forEach((segment, index) => {
    const bar = dayBar.querySelector(`[data-day="${segment.key}"]`);
    const label = dayBar.querySelector(`[data-day-value="${segment.key}"]`);
    bar.style.width = `${((hours[index] * scale) / 24) * 100}%`;
    label.textContent = formatHours(hours[index]);
  });

  dayTotal.textContent = `${formatHours(total)} of 24 h`;
  dayTrack.setAttribute('aria-label', `${formatHours(total)} accounted for out of 24 hours`);

  dayNote.hidden = total <= 24;
  if (total > 24) {
    dayNote.textContent = `These add up to ${formatHours(total)}. If some activities overlap that’s fine; otherwise check the entries.`;
  }
}

/* =========================================================
   API status chip
   ========================================================= */
function setApiStatus(status) {
  const labels = { checking: 'Checking API', online: 'API online', offline: 'API offline' };
  apiStatus.dataset.status = status;
  apiStatusText.textContent = labels[status];
}

async function checkApi() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${API_BASE_URL}/`, { signal: controller.signal });
    setApiStatus(response.ok ? 'online' : 'offline');
  } catch {
    setApiStatus('offline');
  } finally {
    clearTimeout(timeoutId);
  }
}

/* =========================================================
   Result card states
   ========================================================= */
function resetGauge() {
  cancelAnimationFrame(countUpFrame);
  gaugeValue.style.transition = 'none';
  gaugeValue.style.strokeDashoffset = '100';
  gaugeValue.style.opacity = '0';
  void gaugeValue.getBoundingClientRect(); // apply the reset before re-enabling the transition
  gaugeValue.style.transition = '';
  scoreValue.textContent = '–';
}

function setCardState(state) {
  card.dataset.state = state;
  card.setAttribute('aria-busy', String(state === 'loading'));
  delete card.dataset.band;
}

function showIdle() {
  resetGauge();
  setCardState('idle');
  statusRegion.textContent = '';
}

function showLoading() {
  resetGauge();
  setCardState('loading');
  statusRegion.textContent = 'Predicting score.';
}

function animateScore(target) {
  cancelAnimationFrame(countUpFrame);

  if (prefersReducedMotion()) {
    scoreValue.textContent = target.toFixed(2);
    return;
  }

  const duration = 1100;
  const startTime = performance.now();

  const step = (now) => {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    scoreValue.textContent = (target * eased).toFixed(2);
    if (progress < 1) countUpFrame = requestAnimationFrame(step);
  };

  countUpFrame = requestAnimationFrame(step);
}

function showSuccess(score) {
  const band = SCORE_BANDS.find((item) => score < item.below);
  const fraction = clamp((score - SCORE_SCALE.min) / (SCORE_SCALE.max - SCORE_SCALE.min), 0, 1);

  setCardState('success');
  card.dataset.band = band.key;
  bandLabel.textContent = band.label;
  bandMessage.textContent = band.message;
  statusRegion.textContent = `Predicted mental health score: ${score.toFixed(2)} out of ${SCORE_SCALE.max}. ${band.label}.`;

  requestAnimationFrame(() => {
    gaugeValue.style.opacity = '1';
    gaugeValue.style.strokeDashoffset = String(100 - fraction * 100);
  });
  animateScore(score);
}

function showError({ title, message }) {
  resetGauge();
  setCardState('error');
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  statusRegion.textContent = `${title} ${message}`;
}

function revealReadout() {
  // On small screens the result card sits below the form, so bring it into view.
  if (!window.matchMedia('(max-width: 1039px)').matches) return;
  card.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
}

function setSubmitting(flag) {
  isSubmitting = flag;
  submitButton.setAttribute('aria-busy', String(flag));
  submitButton.setAttribute('aria-disabled', String(flag));
  submitLabel.textContent = flag ? 'Predicting…' : 'Predict score';
  resetButton.disabled = flag;
  exampleButton.disabled = flag;
  retryButton.disabled = flag;
}

/* =========================================================
   API request
   ========================================================= */
async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function postPrediction(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(`${API_BASE_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ApiError(error.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timeoutId);
  }

  const body = await parseJson(response);

  if (!response.ok) {
    let kind = 'http';
    if (response.status === 422) kind = 'validation';
    else if (response.status >= 500) kind = 'server';
    throw new ApiError(kind, { status: response.status, detail: body && body.detail });
  }

  const score = body && body.predicted_mental_health_score;
  if (typeof score !== 'number' || !Number.isFinite(score)) throw new ApiError('response');
  return score;
}

async function requestPrediction(payload) {
  setSubmitting(true);
  showLoading();
  revealReadout();
  const startedAt = performance.now();

  try {
    const score = await postPrediction(payload);
    await wait(MIN_LOADING_MS - (performance.now() - startedAt));
    setApiStatus('online');
    showSuccess(score);
  } catch (error) {
    await wait(MIN_LOADING_MS - (performance.now() - startedAt));
    handleFailure(error);
  } finally {
    setSubmitting(false);
  }
}

/* =========================================================
   Error handling
   ========================================================= */
function formatServerMessage(message) {
  const text = String(message || 'Invalid value');
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// FastAPI 422 body: { detail: [{ loc: ['body', 'age'], msg: '...' }, ...] }
function applyServerValidation(detail) {
  const failed = [];
  if (!Array.isArray(detail)) return failed;

  detail.forEach((item) => {
    const location = Array.isArray(item.loc) ? item.loc : [];
    const name = location.find((part) => fieldsByName.has(part));
    if (!name) return;
    setFieldError(name, formatServerMessage(item.msg));
    if (!failed.includes(name)) failed.push(name);
  });

  return failed;
}

function describeError(error, failedFields) {
  switch (error.kind) {
    case 'network':
      return {
        title: 'Can’t reach the API',
        message: `The browser couldn’t connect to ${API_BASE_URL}. Check that the FastAPI server is running, then try again.`,
      };
    case 'timeout':
      return {
        title: 'The request timed out',
        message: `The API didn’t answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again in a moment.`,
      };
    case 'validation':
      return {
        title: 'Some answers were rejected',
        message: failedFields.length > 0
          ? 'The server flagged the highlighted fields. Fix them and try again.'
          : 'The server rejected the submitted values. Check the form and try again.',
      };
    case 'server':
      return {
        title: 'The server hit an error',
        message: `The API returned an internal error (HTTP ${error.status}) while making the prediction. Check the FastAPI terminal for details, then try again.`,
      };
    case 'http':
      return {
        title: `Request failed (HTTP ${error.status})`,
        message: typeof error.detail === 'string' ? error.detail : 'The API couldn’t process this request.',
      };
    case 'response':
      return {
        title: 'Unexpected response',
        message: 'The API replied, but the reply didn’t include a predicted score.',
      };
    default:
      return {
        title: 'Something went wrong',
        message: 'An unexpected error occurred. Try again.',
      };
  }
}

function handleFailure(error) {
  const apiError = error instanceof ApiError ? error : new ApiError('unknown');
  let failedFields = [];

  if (apiError.kind === 'network' || apiError.kind === 'timeout') setApiStatus('offline');

  if (apiError.kind === 'validation') {
    failedFields = applyServerValidation(apiError.detail);
    if (failedFields.length > 0) {
      showSummary(failedFields.length);
      focusField(failedFields[0]);
    }
  }

  showError(describeError(apiError, failedFields));
}

/* =========================================================
   Event handlers
   ========================================================= */
async function onSubmit(event) {
  event.preventDefault();
  if (isSubmitting) return;

  const { payload, invalid } = validateForm();

  if (invalid.length > 0) {
    showSummary(invalid.length);
    focusField(invalid[0]);
    return;
  }

  hideSummary();
  await requestPrediction(payload);
}

function onFocusOut(event) {
  const def = fieldsByName.get(event.target.name);
  if (!def) return;
  // Moving between radios of one group is not leaving the field.
  if (event.relatedTarget && event.relatedTarget.name === event.target.name) return;
  validateSingle(def);
}

function onInput(event) {
  const name = event.target.name;
  const def = fieldsByName.get(name);
  if (!def) return;

  const wrapper = getWrapper(name);
  if (wrapper && wrapper.classList.contains('is-invalid')) validateSingle(def);
  if (dayFieldNames.has(name)) updateDayBar();
  if (!form.querySelector('.is-invalid')) hideSummary();
}

function onReset() {
  // The browser restores default values after this event, so update the UI on the next tick.
  setTimeout(() => {
    clearAllErrors();
    hideSummary();
    updateDayBar();
    showIdle();
  }, 0);
}

function fillExample() {
  Object.entries(EXAMPLE_VALUES).forEach(([name, value]) => {
    form.elements[name].value = value;
  });
  clearAllErrors();
  hideSummary();
  updateDayBar();
}

/* =========================================================
   Init
   ========================================================= */
function init() {
  gaugeMin.textContent = SCORE_SCALE.min;
  gaugeMax.textContent = SCORE_SCALE.max;
  scoreScale.textContent = `out of ${SCORE_SCALE.max}`;

  form.addEventListener('submit', onSubmit);
  form.addEventListener('focusout', onFocusOut);
  form.addEventListener('input', onInput);
  form.addEventListener('reset', onReset);
  exampleButton.addEventListener('click', fillExample);
  retryButton.addEventListener('click', () => form.requestSubmit());

  updateDayBar();
  showIdle();
  checkApi();
}

init();
