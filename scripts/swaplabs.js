(() => {
  // Opening an HTML file directly skips the localhost API adapter that the
  // local server injects into every page. Redirect file:// users to the local
  // app when it is available so authenticated pages (especially Chats) use
  // the same working API path as the rest of the local site.
  if (location.protocol === 'file:') {
    const localOrigin = 'http://localhost:8000';
    const fileName = location.pathname.split('/').pop() || 'index.html';
    const localUrl = `${localOrigin}/${encodeURIComponent(fileName)}${location.search}${location.hash}`;
    // A file:// page cannot reliably fetch localhost because browsers may
    // block that cross-origin request before the local server can answer.
    // Navigate directly so the server can inject the local API adapter.
    location.replace(localUrl);
    return;
  }

  // Keep text readable on dark and blue surfaces even when a page-specific
  // component changes its colors after the shared styles have loaded.
  const contrastStylesheet = document.querySelector('link[rel="stylesheet"][href*="contrast-overrides.css"], link[rel="stylesheet"][href*="swaplabs.css"]');
  if (!contrastStylesheet && document.head) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/styles/contrast-overrides.css?v=20261010-readable4';
    link.dataset.swaplabsContrastStylesheet = 'true';
    document.head.appendChild(link);
  }
  const contrastMarker = 'data-swaplabs-contrast';
  const darkInk = '#172a46';
  const blackInk = '#000000';
  const whiteInk = '#ffffff';
  const contrastOverrides = new WeakMap();
  const contrastCanvas = document.createElement('canvas');
  const contrastContext = contrastCanvas.getContext('2d', {willReadFrequently: true});
  let contrastObserver = null;
  let contrastScanQueued = false;
  let contrastHoverTimer = 0;

  const clamp = value => Math.min(255, Math.max(0, value));
  const parseColor = value => {
    const raw = String(value || '').trim();
    if (!raw || raw === 'transparent' || raw === 'none' || raw === 'currentcolor') return null;
    const rgb = raw.match(/^rgba?\((.*)\)$/i);
    if (rgb) {
      const tokens = rgb[1].replace(/,/g, ' ').replace(/\//g, ' / ').trim().split(/\s+/).filter(Boolean);
      const slash = tokens.indexOf('/');
      const channels = tokens.slice(0, slash >= 0 ? slash : 3);
      const alphaToken = slash >= 0 ? tokens[slash + 1] : tokens[3];
      if (channels.length < 3) return null;
      const channel = token => {
        const number = Number.parseFloat(token);
        return Number.isFinite(number) ? clamp(number * (String(token).includes('%') ? 2.55 : 1)) : NaN;
      };
      const opacity = token => {
        if (token === undefined) return 1;
        const number = Number.parseFloat(token);
        return Number.isFinite(number) ? Math.min(1, Math.max(0, number * (String(token).includes('%') ? .01 : 1))) : NaN;
      };
      const [r, g, b] = channels.map(channel);
      const a = opacity(alphaToken);
      if (![r, g, b, a].every(Number.isFinite)) return null;
      return {r, g, b, a};
    }
    const hex = raw.match(/^#([\da-f]{3,8})$/i);
    if (hex) {
      let digits = hex[1];
      if (digits.length === 3 || digits.length === 4) digits = [...digits].map(digit => digit + digit).join('');
      if (digits.length !== 6 && digits.length !== 8) return null;
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1
      };
    }
    if (!contrastContext) return null;
    contrastContext.fillStyle = '#010203';
    try { contrastContext.fillStyle = raw; } catch (_error) { return null; }
    const normalized = contrastContext.fillStyle;
    if (normalized === '#010203' && raw.toLowerCase() !== '#010203') return null;
    if (/^#[\da-f]{3,8}$/i.test(normalized)) return parseColor(normalized);
    const normalizedRgb = normalized.match(/^rgba?\((.*)\)$/i);
    return normalizedRgb ? parseColor(normalizedRgb[0]) : null;
  };
  const colorsIn = value => {
    const source = String(value || '').replace(/url\([^)]*\)/gi, ' ');
    const tokens = source.match(/#[\da-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\b[a-z]+\b/gi) || [];
    return tokens.map(parseColor).filter(Boolean);
  };
  const interpolate = (first, second, amount) => ({
    r: first.r + (second.r - first.r) * amount,
    g: first.g + (second.g - first.g) * amount,
    b: first.b + (second.b - first.b) * amount,
    a: first.a + (second.a - first.a) * amount
  });
  const sampleGradient = value => {
    const stops = colorsIn(value);
    if (stops.length < 2) return stops;
    const samples = [stops[0]];
    for (let index = 1; index < stops.length; index += 1) {
      for (const amount of [.2, .4, .6, .8, 1]) samples.push(interpolate(stops[index - 1], stops[index], amount));
    }
    return samples;
  };
  const composite = (foreground, background) => ({
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1
  });
  const linearChannel = value => {
    value /= 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const luminance = ({r, g, b}) => .2126 * linearChannel(r) + .7152 * linearChannel(g) + .0722 * linearChannel(b);
  const contrastRatio = (first, second) => {
    const high = Math.max(luminance(first), luminance(second));
    const low = Math.min(luminance(first), luminance(second));
    return (high + .05) / (low + .05);
  };
  const blueOrDark = ({r, g, b, a = 1}) => {
    if (a < .72) return false;
    const light = luminance({r, g, b});
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    const saturation = max === 0 ? 0 : delta / max;
    return light < .36 || (hue >= 185 && hue <= 285 && saturation >= .2);
  };
  const isTextGradient = style => /gradient\(/i.test(style.backgroundImage || '') &&
    [style.backgroundClip, style.webkitBackgroundClip].some(value =>
      String(value || '').split(',').some(clip => clip.trim() === 'text')
    );
  const restoreProperty = (style, name, value, priority) => {
    if (value) style.setProperty(name, value, priority || '');
    else style.removeProperty(name);
  };
  const rememberOriginalStyles = element => ({
    color: element.style.getPropertyValue('color'),
    colorPriority: element.style.getPropertyPriority('color'),
    fill: element.style.getPropertyValue('fill'),
    fillPriority: element.style.getPropertyPriority('fill'),
    textFill: element.style.getPropertyValue('-webkit-text-fill-color'),
    textFillPriority: element.style.getPropertyPriority('-webkit-text-fill-color')
  });
  const pseudoSnapshot = (element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    return {
      content: String(style.content || ''),
      color: style.color,
      textFill: style.webkitTextFillColor,
      opacity: style.opacity
    };
  };
  const styleSnapshot = (element, style) => ({
    color: style.color,
    fill: style.fill,
    textFill: style.webkitTextFillColor,
    backgroundImage: style.backgroundImage,
    backgroundClip: style.backgroundClip,
    webkitBackgroundClip: style.webkitBackgroundClip,
    placeholder: element.matches('input,textarea') && element.hasAttribute('placeholder') && !String(element.value || '')
      ? pseudoSnapshot(element, '::placeholder') : null,
    before: pseudoSnapshot(element, '::before'),
    after: pseudoSnapshot(element, '::after')
  });
  const originalStylesChangedWhileMarked = (style, original, state) => {
    const currentColor = style.getPropertyValue('color');
    const currentFill = style.getPropertyValue('fill');
    const currentTextFill = style.getPropertyValue('-webkit-text-fill-color');
    if (currentColor !== state.appliedColor || style.getPropertyPriority('color') !== 'important') {
      original.color = currentColor;
      original.colorPriority = style.getPropertyPriority('color');
    }
    if (currentFill !== state.appliedFill || style.getPropertyPriority('fill') !== 'important') {
      original.fill = currentFill;
      original.fillPriority = style.getPropertyPriority('fill');
    }
    if (currentTextFill !== state.appliedTextFill || style.getPropertyPriority('-webkit-text-fill-color') !== 'important') {
      original.textFill = currentTextFill;
      original.textFillPriority = style.getPropertyPriority('-webkit-text-fill-color');
    }
  };
  const naturalTextStyle = element => {
    const state = contrastOverrides.get(element);
    if (!state) return styleSnapshot(element, getComputedStyle(element));
    const style = element.style;
    const current = {
      color: style.getPropertyValue('color'), colorPriority: style.getPropertyPriority('color'),
      fill: style.getPropertyValue('fill'), fillPriority: style.getPropertyPriority('fill'),
      textFill: style.getPropertyValue('-webkit-text-fill-color'), textFillPriority: style.getPropertyPriority('-webkit-text-fill-color')
    };
    originalStylesChangedWhileMarked(style, state.original, state);
    element.removeAttribute(contrastMarker);
    restoreProperty(style, 'color', state.original.color, state.original.colorPriority);
    restoreProperty(style, 'fill', state.original.fill, state.original.fillPriority);
    restoreProperty(style, '-webkit-text-fill-color', state.original.textFill, state.original.textFillPriority);
    const computed = getComputedStyle(element);
    const natural = styleSnapshot(element, computed);
    restoreProperty(style, 'color', current.color, current.colorPriority);
    restoreProperty(style, 'fill', current.fill, current.fillPriority);
    restoreProperty(style, '-webkit-text-fill-color', current.textFill, current.textFillPriority);
    element.setAttribute(contrastMarker, state.variant);
    return natural;
  };
  const clearContrastOverride = element => {
    const state = contrastOverrides.get(element);
    if (!state) return;
    element.removeAttribute(contrastMarker);
    restoreProperty(element.style, 'color', state.original.color, state.original.colorPriority);
    restoreProperty(element.style, 'fill', state.original.fill, state.original.fillPriority);
    restoreProperty(element.style, '-webkit-text-fill-color', state.original.textFill, state.original.textFillPriority);
    contrastOverrides.delete(element);
  };
  const setContrastOverride = (element, color) => {
    const style = element.style;
    let state = contrastOverrides.get(element);
    if (!state) {
      state = {original: rememberOriginalStyles(element), variant: '', appliedColor: '', appliedFill: '', appliedTextFill: ''};
      contrastOverrides.set(element, state);
    } else {
      originalStylesChangedWhileMarked(style, state.original, state);
    }
    const variant = color.toLowerCase() === whiteInk ? 'inverse' : 'readable';
    const appliedColor = color;
    const appliedFill = color;
    const appliedTextFill = color;
    if (style.getPropertyValue('color') !== appliedColor || style.getPropertyPriority('color') !== 'important') style.setProperty('color', appliedColor, 'important');
    if (style.getPropertyValue('fill') !== appliedFill || style.getPropertyPriority('fill') !== 'important') style.setProperty('fill', appliedFill, 'important');
    if (style.getPropertyValue('-webkit-text-fill-color') !== appliedTextFill || style.getPropertyPriority('-webkit-text-fill-color') !== 'important') style.setProperty('-webkit-text-fill-color', appliedTextFill, 'important');
    state.variant = variant;
    state.appliedColor = appliedColor;
    state.appliedFill = appliedFill;
    state.appliedTextFill = appliedTextFill;
    if (element.getAttribute(contrastMarker) !== variant) element.setAttribute(contrastMarker, variant);
  };
  const effectiveBackgrounds = element => {
    const darkTheme = document.documentElement.matches('[data-theme="dark"], .theme-dark') || document.body?.classList.contains('theme-dark');
    let backgrounds = [parseColor(darkTheme ? '#171923' : '#ffffff')];
    const ancestors = [];
    for (let node = element; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) ancestors.push(node);
    ancestors.reverse();
    for (const node of ancestors) {
      const style = getComputedStyle(node);
      const base = parseColor(style.backgroundColor);
      if (base && base.a > 0) backgrounds = backgrounds.map(background => composite(base, background));
      if (!isTextGradient(style)) {
        const gradient = sampleGradient(style.backgroundImage);
        if (gradient.length) backgrounds = gradient.flatMap(stop => backgrounds.map(background => composite(stop, background)));
      }
      const unique = new Map();
      backgrounds.forEach(background => unique.set([background.r, background.g, background.b].map(value => Math.round(value / 4)).join(':'), background));
      backgrounds = [...unique.values()].slice(-40);
    }
    return backgrounds.length ? backgrounds : [parseColor('#ffffff')];
  };
  const colorContrast = (foreground, backgrounds) => Math.min(...backgrounds.map(background => {
    const rendered = foreground.a < 1 ? composite(foreground, background) : foreground;
    return contrastRatio(rendered, background);
  }));
  const largeTextThreshold = (element, style) => {
    const size = Number.parseFloat(style.fontSize) || 16;
    const weight = Number.parseInt(style.fontWeight, 10) || 400;
    return size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
  };
  const visiblePseudoColor = (style, backgrounds) => {
    const content = String(style.content || '').replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!content || content === 'none' || content === 'normal') return null;
    const color = parseColor(style.textFill) || parseColor(style.color);
    if (!color) return null;
    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity)) color.a *= Math.max(0, Math.min(1, opacity));
    return {color, ratio: colorContrast(color, backgrounds)};
  };
  const refreshContrastMarkers = () => {
    contrastScanQueued = false;
    if (!document.body) return;
    // Inline contrast adjustments can change computed styles. Suspend this
    // observer during the synchronous scan so those own changes do not queue
    // an endless scan loop.
    contrastObserver?.disconnect();
    try {
      document.body.querySelectorAll('*').forEach(element => {
        const existing = contrastOverrides.has(element);
        const textNodes = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue || ''));
        const isControl = element.matches('button,input,select,textarea,option');
        if (!textNodes && !isControl) {
          if (existing) clearContrastOverride(element);
          return;
        }
        const visibility = getComputedStyle(element);
        if (element.hidden || element.getAttribute('aria-hidden') === 'true' || visibility.display === 'none' || visibility.visibility === 'hidden' || !element.getClientRects().length) {
          if (existing) clearContrastOverride(element);
          return;
        }
        const natural = naturalTextStyle(element);
        const style = getComputedStyle(element);
        const backgrounds = effectiveBackgrounds(element);
        const threshold = largeTextThreshold(element, style);
        const textGradient = isTextGradient(natural);
        const foregroundColors = textGradient ? sampleGradient(natural.backgroundImage) : [];
        if (!foregroundColors.length) {
          const fill = parseColor(natural.textFill);
          const svgFill = element.namespaceURI === 'http://www.w3.org/2000/svg' ? parseColor(natural.fill) : null;
          const foreground = fill && fill.a > 0 ? fill : (svgFill || parseColor(natural.color));
          if (foreground) foregroundColors.push(foreground);
        }
        let weakest = foregroundColors.length ? Math.min(...foregroundColors.map(color => colorContrast(color, backgrounds))) : 0;
        const placeholderVisible = isControl && natural.placeholder;
        if (placeholderVisible) {
          const placeholderColor = parseColor(natural.placeholder.textFill) || parseColor(natural.placeholder.color);
          if (placeholderColor) {
            const opacity = Number.parseFloat(natural.placeholder.opacity);
            if (Number.isFinite(opacity)) placeholderColor.a *= Math.max(0, Math.min(1, opacity));
            weakest = Math.min(weakest, colorContrast(placeholderColor, backgrounds));
          }
        }
        const pseudoColors = [natural.before, natural.after].map(pseudo => visiblePseudoColor(pseudo, backgrounds)).filter(Boolean);
        if (pseudoColors.length) weakest = Math.min(weakest, ...pseudoColors.map(item => item.ratio));
        const whiteRatio = colorContrast(parseColor(whiteInk), backgrounds);
        const blueOrDarkSurface = backgrounds.some(blueOrDark);
        // Preserve the white-on-blue/dark convention wherever white can meet
        // the text size's contrast threshold. On a pale blue surface, use the
        // darker ink that keeps the words legible.
        if (blueOrDarkSurface && whiteRatio >= threshold) {
          setContrastOverride(element, whiteInk);
          return;
        }
        if (weakest >= threshold) {
          if (existing) clearContrastOverride(element);
          return;
        }
        const candidates = [whiteInk, darkInk, blackInk].map(parseColor);
        const best = candidates.reduce((winner, candidate) =>
          colorContrast(candidate, backgrounds) > colorContrast(winner, backgrounds) ? candidate : winner
        );
        const chosen = best.r > 245 && best.g > 245 && best.b > 245 ? whiteInk :
          (best.r < 8 && best.g < 8 && best.b < 8 ? blackInk : darkInk);
        setContrastOverride(element, chosen);
      });
    } finally {
      contrastObserver?.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-selected', 'aria-pressed', 'aria-expanded', 'hidden', 'data-theme']
      });
    }
  };
  const queueContrastScan = () => {
    if (contrastScanQueued) return;
    contrastScanQueued = true;
    requestAnimationFrame(refreshContrastMarkers);
  };
  if (document.body) {
    queueContrastScan();
    contrastObserver = new MutationObserver(queueContrastScan);
    contrastObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-selected', 'aria-pressed', 'aria-expanded', 'hidden', 'data-theme']
    });
    document.addEventListener('pointerover', () => {
      queueContrastScan();
      clearTimeout(contrastHoverTimer);
      contrastHoverTimer = setTimeout(queueContrastScan, 260);
    }, true);
    ['focusin', 'click'].forEach(type => document.addEventListener(type, queueContrastScan, true));
  }

  // A profile image can outlive the storage backend that served it. Keep the
  // identity card usable when that happens instead of exposing the browser's
  // broken-image icon and alt text inside the avatar.
  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !/\bprofile photo$/i.test(String(image.alt || ''))) return;
    const label = String(image.alt || '').replace(/\s+profile photo$/i, '').trim();
    const fallback = document.createElement('span');
    fallback.className = 'avatar-fallback';
    fallback.setAttribute('aria-label', `${label || 'Member'} initials`);
    fallback.textContent = label.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'SM';
    image.replaceWith(fallback);
  }, true);

  // Keep a tiny, non-sensitive session hint so the shared navigation can
  // render immediately while the server validates the real cookie in the
  // background.  This never grants access to a private API or replaces the
  // server-side session check.
  const authSnapshotKey = 'swaplabs-auth-snapshot-v1';
  const authSnapshotMaxAge = 24 * 60 * 60 * 1000;
  const snapshotUser = user => {
    if (!user || typeof user !== 'object') return null;
    const profile = user.profile || {};
    return {
      id: user.id || '', username: user.username || '', role: user.role || 'member',
      time_credits: Number(user.time_credits || 0),
      profile: {
        display_name: profile.display_name || user.username || 'SwapLabs member',
        profile_color: profile.profile_color || 'indigo', avatar_url: profile.avatar_url || '',
        skills_to_teach: Array.isArray(profile.skills_to_teach) ? profile.skills_to_teach.slice(0, 3) : [],
        skills_to_learn: Array.isArray(profile.skills_to_learn) ? profile.skills_to_learn.slice(0, 3) : []
      }
    };
  };
  const readAuthSnapshot = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(authSnapshotKey) || 'null');
      if (!saved || Date.now() - Number(saved.saved_at || 0) > authSnapshotMaxAge) return null;
      return snapshotUser(saved.user);
    } catch (_error) { return null; }
  };
  const writeAuthSnapshot = user => {
    try {
      const safe = snapshotUser(user);
      if (safe) localStorage.setItem(authSnapshotKey, JSON.stringify({saved_at: Date.now(), user: safe}));
      else localStorage.removeItem(authSnapshotKey);
    } catch (_error) { /* Storage can be disabled; the live session still works. */ }
  };
  let authRequest;
  const getAuth = () => {
    if (!authRequest) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      authRequest = fetch('/api/auth/me', {credentials: 'same-origin', cache: 'no-store', signal: controller.signal})
        .then(async response => {
          if (!response.ok) throw new Error('The SwapLabs session could not be checked.');
          const result = await response.json();
          writeAuthSnapshot(result.authenticated ? result.user : null);
          return result;
        })
        .finally(() => window.clearTimeout(timeout))
        .catch(error => { authRequest = null; throw error; });
    }
    return authRequest;
  };
  window.SwapLabsAuth = {
    get: getAuth,
    snapshot: readAuthSnapshot,
    remember: writeAuthSnapshot,
    reset: () => { authRequest = null; }
  };

  // One shared completion rule keeps the client experience and the protected
  // API actions aligned. Browsing stays open to everyone, while actions that
  // create member relationships or commitments can ask the member to finish
  // the profile they already started.
  const PROFILE_GATE_FIELDS = [
    ['first_name', 'First name'],
    ['last_name', 'Last name'],
    ['date_of_birth', 'Date of birth'],
    ['country', 'Country'],
    ['primary_language', 'Primary language'],
    ['skills_to_teach', 'A skill you can teach'],
    ['skills_to_learn', 'A skill you want to learn'],
    ['learning_goal', 'Main learning goal']
  ];
  const profileGateFieldFilled = value => {
    if (Array.isArray(value)) return value.some(profileGateFieldFilled);
    const normalized = String(value ?? '').trim().toLowerCase();
    return Boolean(normalized) && normalized !== 'nothing for now';
  };
  const profileGateCompleteness = user => {
    if (!user) return 0;
    if (user.role === 'admin') return 100;
    const profile = user.profile || {};
    return Math.round(PROFILE_GATE_FIELDS.filter(([field]) => profileGateFieldFilled(profile[field])).length /
      PROFILE_GATE_FIELDS.length * 100);
  };
  const profileGateMissing = user => {
    const profile = user?.profile || {};
    return PROFILE_GATE_FIELDS.filter(([field]) => !profileGateFieldFilled(profile[field])).map(([, label]) => label);
  };
  const profileGatePage = () => {
    const rawPage = location.pathname.split('/').filter(Boolean).pop() || 'index.html';
    return rawPage.includes('.') ? rawPage : `${rawPage}.html`;
  };
  const profileGateDestination = value => {
    const fallback = `${profileGatePage()}${location.search}${location.hash}`;
    const raw = String(value || '').trim() || fallback;
    if (raw.startsWith('//')) return fallback;
    try {
      const target = new URL(raw, location.href);
      if (target.origin !== location.origin || !/\.html$/i.test(target.pathname)) return fallback;
      return `${target.pathname.replace(/^\//, '')}${target.search}${target.hash}`;
    } catch (_error) {
      return fallback;
    }
  };
  const profileGateHref = value => `profile.html?complete=1&return_to=${encodeURIComponent(profileGateDestination(value))}`;
  const PROFILE_GATE_ROUTES = new Set([
    'skill-matching.html', 'calendar.html', 'portfolio.html', 'swapjobs.html',
    'projects.html', 'marketplace.html', 'credits.html', 'gifts.html', 'learning-journal.html',
    'skill-innovation.html', 'community-challenges.html', 'skill-battle.html', 'livestreams.html',
    'session-room.html', 'video-room.html', 'mentor-dashboard.html', 'become-a-mentor.html',
    'organization.html', 'organization-admin.html'
  ]);
  const profileGateState = {user: null, ready: false, redirecting: false};
  const profileGateNeedsCompletion = user => Boolean(user && profileGateCompleteness(user) < 100);
  const profileGateSnoozeKey = user => user?.id ? `relayskills-profile-setup-snooze:${user.id}` : '';
  const profileGateIsSnoozed = user => {
    const key = profileGateSnoozeKey(user);
    if (!key) return false;
    try { return Number(localStorage.getItem(key) || 0) > Date.now(); } catch (_error) { return false; }
  };
  const snoozeProfileGate = user => {
    const key = profileGateSnoozeKey(user);
    if (!key) return;
    try { localStorage.setItem(key, String(Date.now() + 24 * 60 * 60 * 1000)); } catch (_error) { /* Storage can be unavailable. */ }
  };
  const isProfileGateDestination = href => {
    try {
      const target = new URL(href, location.href);
      if (target.origin !== location.origin) return false;
      const rawPage = target.pathname.split('/').filter(Boolean).pop() || 'index.html';
      const page = rawPage.includes('.') ? rawPage : `${rawPage}.html`;
      return PROFILE_GATE_ROUTES.has(page);
    } catch (_error) {
      return false;
    }
  };
  const ensureProfileGateModal = () => {
    let modal = document.getElementById('profileGateModal');
    if (modal) return modal;
    document.body.insertAdjacentHTML('beforeend', `<div class="profile-gate-backdrop" id="profileGateModal" hidden role="dialog" aria-modal="true" aria-labelledby="profileGateTitle">
      <div class="profile-gate-card">
        <button class="profile-gate-close" type="button" data-profile-gate-close aria-label="Close profile checkpoint"><i class="bx bx-x"></i></button>
        <span class="profile-gate-kicker"><i class="bx bx-user-check"></i> Profile checkpoint</span>
        <h2 id="profileGateTitle">Finish your profile first.</h2>
        <p data-profile-gate-copy>Complete the details that help SwapLabs make safe, useful introductions.</p>
        <div class="profile-gate-progress"><div><strong data-profile-gate-percent>0%</strong><span>profile complete</span></div><span class="profile-gate-progress-track"><i data-profile-gate-progress></i></span></div>
        <ul class="profile-gate-missing" data-profile-gate-missing></ul>
        <div class="profile-gate-actions"><a class="btn btn-primary" data-profile-gate-profile href="profile.html?complete=1">Continue finishing your profile <i class="bx bx-right-arrow-alt"></i></a><button class="btn" type="button" data-profile-gate-later>Choose another day</button></div>
      </div>
    </div>`);
    modal = document.getElementById('profileGateModal');
    modal.querySelectorAll('[data-profile-gate-close]').forEach(button => button.addEventListener('click', closeProfileGate));
    modal.querySelector('[data-profile-gate-later]')?.addEventListener('click', () => {
      snoozeProfileGate(profileGateState.user);
      closeProfileGate();
    });
    modal.addEventListener('click', event => { if (event.target === modal) closeProfileGate(); });
    return modal;
  };
  const closeProfileGate = () => {
    const modal = document.getElementById('profileGateModal');
    if (!modal) return;
    modal.hidden = true;
    modal.classList.remove('is-open');
    document.body.classList.remove('profile-gate-open');
  };
  const openProfileGate = (details = {}) => {
    const modal = ensureProfileGateModal();
    const user = details.user || profileGateState.user;
    const percent = Number.isFinite(Number(details.profile_completeness)) ? Number(details.profile_completeness) : profileGateCompleteness(user);
    const missing = Array.isArray(details.required_profile_fields) && details.required_profile_fields.length ?
      details.required_profile_fields : profileGateMissing(user);
    const copy = modal.querySelector('[data-profile-gate-copy]');
    const percentNode = modal.querySelector('[data-profile-gate-percent]');
    const progress = modal.querySelector('[data-profile-gate-progress]');
    const list = modal.querySelector('[data-profile-gate-missing]');
    const profileLink = modal.querySelector('[data-profile-gate-profile]');
    if (copy) copy.textContent = 'Finish these essentials to unlock matching, scheduling, and other member actions. Optional details can wait.';
    if (percentNode) percentNode.textContent = `${percent}%`;
    if (progress) progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (list) list.innerHTML = missing.slice(0, 5).map(label => `<li><i class="bx bx-circle"></i><span>${String(label)}</span></li>`).join('');
    if (profileLink) profileLink.href = details.profile_url && /^profile\.html\?/.test(details.profile_url) ? details.profile_url : profileGateHref(details.return_to || details.returnTo);
    modal.hidden = false;
    modal.classList.add('is-open');
    document.body.classList.add('profile-gate-open');
    modal.querySelector('[data-profile-gate-close]')?.focus();
  };
  const renderProfileGateNotice = user => {
    if (profileGatePage() !== 'profile.html' || new URLSearchParams(location.search).get('complete') !== '1') return;
    const host = document.querySelector('.account-section .container') || document.querySelector('main');
    if (!host) return;
    const params = new URLSearchParams(location.search);
    const welcome = params.get('welcome') === '1';
    let notice = document.getElementById('profileGateNotice');
    if (!notice) {
      notice = document.createElement('section');
      notice.id = 'profileGateNotice';
      notice.className = 'profile-gate-notice';
      notice.setAttribute('role', 'status');
      host.insertBefore(notice, host.firstElementChild);
    }
    const complete = !profileGateNeedsCompletion(user);
    const percent = profileGateCompleteness(user);
    const missing = profileGateMissing(user);
    notice.classList.toggle('complete', complete);
    notice.classList.toggle('welcome', welcome && !complete);
    notice.innerHTML = complete ?
      '<i class="bx bx-check-circle"></i><div><strong>Your profile is complete.</strong><span>Everything is ready. Taking you back to the action you requested…</span></div>' :
      welcome ?
        `<i class="bx bx-user-check" aria-hidden="true"></i><div><strong>You’re in — finish your profile now.</strong><span>${percent}% complete. This first pass is only the essentials; optional details can wait.</span><div class="profile-welcome-checklist"><span><i class="bx bx-map" aria-hidden="true"></i> Location + language</span><span><i class="bx bx-bulb" aria-hidden="true"></i> Skills + goal</span></div><div class="profile-welcome-actions"><a class="btn btn-primary btn-sm" href="#identity">Finish your profile <i class="bx bx-right-arrow-alt" aria-hidden="true"></i></a></div></div>` :
        `<i class="bx bx-lock-alt"></i><div><strong>Finish your profile to unlock member actions.</strong><span>${percent}% complete. Add ${missing.slice(0, 3).join(', ').toLowerCase()}${missing.length > 3 ? ', and the remaining essentials' : ''}.</span></div>`;
  };
  const lockMatchingSurface = user => {
    if (profileGatePage() !== 'skill-matching.html') return;
    const form = document.getElementById('advancedMatchForm');
    if (!form) return;
    const needsProfileDetails = profileGateNeedsCompletion(user);
    let notice = document.getElementById('matchingProfileGate');
    if (needsProfileDetails && !notice) {
      notice = document.createElement('div');
      notice.id = 'matchingProfileGate';
      notice.className = 'profile-gate-inline matching-profile-advisory';
      form.parentNode.insertBefore(notice, form);
    }
    if (notice && needsProfileDetails) {
      notice.innerHTML = '<i class="bx bx-info-circle"></i><div><strong>You can search and request a swap now.</strong><span>Some profile details are still missing. Finish your profile anytime to improve match context and recommendations.</span><a class="btn btn-primary btn-sm" href="profile.html?complete=1&return_to=skill-matching.html%3Fintent%3Dswap%23advancedMatchForm">Finish profile <i class="bx bx-right-arrow-alt"></i></a></div>';
    }
    if (notice) notice.hidden = !needsProfileDetails;
    // Matching is a useful discovery tool even while the optional profile
    // context is incomplete. The request endpoint still applies the full
    // profile and safety checks before a swap is sent.
    form.classList.toggle('profile-gated-form', false);
    form.setAttribute('aria-disabled', 'false');
    form.querySelectorAll('input, select, textarea, button').forEach(control => {
      if (control.dataset.profileGateDisabled) {
        control.disabled = false;
        delete control.dataset.profileGateDisabled;
      }
    });
  };
  const applyProfileGateUser = user => {
    profileGateState.user = user || null;
    profileGateState.ready = true;
    renderProfileGateNotice(profileGateState.user);
    lockMatchingSurface(profileGateState.user);
    const params = new URLSearchParams(location.search);
    const returnTo = profileGateDestination(params.get('return_to'));
    if (profileGatePage() === 'profile.html' && params.get('complete') === '1' && returnTo && !returnTo.startsWith('profile.html') &&
        !profileGateNeedsCompletion(profileGateState.user) && !profileGateState.redirecting) {
      profileGateState.redirecting = true;
      setTimeout(() => { location.href = returnTo; }, 700);
    }
  };
  window.SwapLabsProfileGate = {
    fields: PROFILE_GATE_FIELDS,
    completeness: profileGateCompleteness,
    missing: profileGateMissing,
    isComplete: user => profileGateCompleteness(user) >= 100,
    needsCompletion: user => profileGateNeedsCompletion(user || profileGateState.user),
    open: openProfileGate,
    close: closeProfileGate,
    isSnoozed: user => profileGateIsSnoozed(user || profileGateState.user),
    snooze: user => snoozeProfileGate(user || profileGateState.user),
    profileHref: profileGateHref,
    currentUser: () => profileGateState.user
  };
  const escapeNoticeAttribute = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
  const profileCompletionNotice = (message, type = 'error') => {
    const text = typeof message === 'object' ? message?.message : message;
    const code = typeof message === 'object' ? message?.code : '';
    return type === 'error' && (code === 'profile_incomplete' || /finish your profile|complete your profile|profile is incomplete/i.test(String(text || '')));
  };
  const profileNoticeSelectors = [
    '.platform-toast', '.auth-toast', '.form-status.error', '.platform-form-status.error',
    '.ops-form-status.error', '.media-form-status.error', '.blog-form-status.error',
    '.feature-status.error', '.video-inline-status.error', '.gifts-status.error'
  ].join(',');
  const noticeMessage = element => {
    const copy = element?.querySelector('.toast-copy span');
    return String(copy?.textContent || element?.textContent || '').trim();
  };
  const noticeType = element => element?.classList.contains('error') ? 'error' :
    element?.classList.contains('info') ? 'info' : element?.classList.contains('success') ? 'success' : 'error';
  const actionLinkForNotice = (message, type = 'error') => {
    if (!profileCompletionNotice(message, type)) return '';
    const details = typeof message === 'object' ? message : {};
    const href = details.profile_url && /^profile\.html\?/.test(details.profile_url) ? details.profile_url :
      window.SwapLabsProfileGate.profileHref(details.return_to || details.returnTo);
    return `<a class="toast-action-link" href="${escapeNoticeAttribute(href)}">Continue finishing your profile <i class="bx bx-right-arrow-alt" aria-hidden="true"></i></a>`;
  };
  const enhanceProfileNotice = (element, message, type) => {
    if (!element || element.querySelector('.toast-action-link')) return false;
    const resolvedMessage = message || noticeMessage(element);
    const actionLink = actionLinkForNotice(resolvedMessage, type || noticeType(element));
    if (!actionLink) return false;
    const copy = element.querySelector('.toast-copy');
    if (copy) {
      copy.insertAdjacentHTML('beforeend', actionLink);
    } else {
      const icon = element.querySelector(':scope > i');
      const text = document.createElement('span');
      text.textContent = resolvedMessage;
      const nextCopy = document.createElement('div');
      nextCopy.className = 'toast-copy';
      nextCopy.append(text);
      nextCopy.insertAdjacentHTML('beforeend', actionLink);
      element.replaceChildren();
      if (icon) element.append(icon);
      element.append(nextCopy);
    }
    element.classList.add('has-action-link');
    return true;
  };
  window.SwapLabsNotice = {
    actionLink: actionLinkForNotice,
    enhance: enhanceProfileNotice
  };
  const scanProfileNotices = root => {
    if (!root?.querySelectorAll) return;
    if (root.nodeType === 1 && root.matches(profileNoticeSelectors)) enhanceProfileNotice(root);
    root.querySelectorAll(profileNoticeSelectors).forEach(enhanceProfileNotice);
  };
  const observeProfileNotices = () => {
    if (!document.body) return;
    scanProfileNotices(document.body);
    if (!window.MutationObserver) return;
    const observer = new MutationObserver(records => records.forEach(record => {
      if (record.type === 'attributes') scanProfileNotices(record.target);
      else record.addedNodes.forEach(scanProfileNotices);
    }));
    observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['class']});
  };
  if (document.body) observeProfileNotices();
  else document.addEventListener('DOMContentLoaded', observeProfileNotices, {once: true});
  window.addEventListener('keydown', event => { if (event.key === 'Escape') closeProfileGate(); });
  window.addEventListener('swaplabs:auth-state', event => applyProfileGateUser(event.detail?.user || null));
  window.addEventListener('swaplabs:profile-updated', event => applyProfileGateUser(event.detail?.user || null));
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target === '_blank' || !profileGateState.ready || !profileGateNeedsCompletion() || !isProfileGateDestination(link.href)) return;
    event.preventDefault();
    openProfileGate({return_to: profileGateDestination(link.href)});
  }, true);
  document.addEventListener('submit', event => {
    const target = event.target;
    if (!profileGateState.ready || !profileGateNeedsCompletion() ||
        (target.matches('#advancedMatchForm') && profileGatePage() === 'skill-matching.html') ||
        !target.matches('[data-profile-required-form]')) return;
    event.preventDefault();
    openProfileGate({return_to: profileGateDestination()});
  }, true);
  setTimeout(async () => {
    try {
      const auth = await getAuth();
      applyProfileGateUser(auth?.authenticated ? auth.user : null);
    } catch (_error) {
      // The protected API remains authoritative if a transient auth check fails.
    }
  }, 0);

  const preferenceDefaults = {
    theme: 'light',
    font_scale: 'default',
    content_density: 'comfortable',
    navigation_style: 'expanded',
    default_landing: 'dashboard',
    high_contrast: false,
    reduced_motion: false,
    link_underlines: false,
    focus_mode: false,
    show_ai_assistant: true,
    auto_play_testimonials: true
  };
  const preferenceKey = 'swaplabs-ui-preferences';
  const readStoredPreferences = () => {
    try {
      return {
        ...preferenceDefaults,
        ...JSON.parse(localStorage.getItem(preferenceKey) || '{}')
      };
    } catch (_error) {
      return {
        ...preferenceDefaults
      };
    }
  };
  const applyPreferences = (incoming = {}, persist = true) => {
    const preferences = {
      ...readStoredPreferences(),
      ...incoming
    };
    const root = document.documentElement;
    root.dataset.theme = preferences.theme === 'dark' ? 'dark' : 'light';
    root.dataset.fontScale = ['small', 'default', 'large', 'extra-large'].includes(preferences.font_scale) ?
      preferences.font_scale : 'default';
    root.dataset.density = preferences.content_density === 'compact' ? 'compact' : 'comfortable';
    root.dataset.navigation = preferences.navigation_style === 'compact' ? 'compact' : 'expanded';
    root.classList.toggle('pref-high-contrast', Boolean(preferences.high_contrast));
    root.classList.toggle('pref-reduced-motion', Boolean(preferences.reduced_motion));
    root.classList.toggle('pref-link-underlines', Boolean(preferences.link_underlines));
    root.classList.toggle('pref-focus-mode', Boolean(preferences.focus_mode));
    root.classList.toggle('pref-hide-assistant', preferences.show_ai_assistant === false);
    root.classList.toggle('pref-pause-testimonials', preferences.auto_play_testimonials === false);
    root.style.colorScheme = root.dataset.theme;
    if (persist) localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    window.dispatchEvent(new CustomEvent('swaplabs:preferences-applied', {
      detail: preferences
    }));
    return preferences;
  };
  window.SwapLabsPreferences = {
    defaults: preferenceDefaults,
    read: readStoredPreferences,
    hasStored: key => {
      try {
        const raw = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
        return Object.prototype.hasOwnProperty.call(raw, key);
      } catch (_error) {
        return false;
      }
    },
    apply: applyPreferences
  };
  applyPreferences(readStoredPreferences(), false);
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey) applyPreferences(readStoredPreferences(), false);
  });
  document.head.insertAdjacentHTML('beforeend',
    '<style>.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}@media(max-width:650px){.grid-2{grid-template-columns:1fr}}.platform-toast .toast-copy,.auth-toast .toast-copy{display:flex;min-width:0;flex:1;flex-direction:column;align-items:flex-start;gap:7px}.toast-action-link{display:inline-flex;align-items:center;gap:5px;width:max-content;max-width:100%;color:#bfc9ff;font-size:.74rem;font-weight:800;line-height:1.3;text-decoration:underline;text-underline-offset:3px;pointer-events:auto}.toast-action-link:hover,.toast-action-link:focus-visible{color:#fff}.platform-toast.has-action-link,.auth-toast.has-action-link{pointer-events:auto}:is(.form-status,.platform-form-status,.ops-form-status,.media-form-status,.blog-form-status,.feature-status,.video-inline-status,.gifts-status).has-action-link{display:flex;flex-direction:column;align-items:flex-start;gap:7px}:is(.form-status,.platform-form-status,.ops-form-status,.media-form-status,.blog-form-status,.feature-status,.video-inline-status,.gifts-status).has-action-link .toast-copy{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:7px}:is(.form-status,.platform-form-status,.ops-form-status,.media-form-status,.blog-form-status,.feature-status,.video-inline-status,.gifts-status).has-action-link .toast-action-link{color:currentColor;font-size:.76rem}</style>'
    );
  // Boxicons is self-hosted so icons remain available when a browser, CSP, or
  // network policy blocks third-party stylesheets. Remove the legacy CDN link
  // if an older cached shell inserted it before this code ran.
  document.querySelectorAll('link[href*="cdn.jsdelivr.net/npm/boxicons"]').forEach(link => link.remove());
  if (!document.querySelector('link[href*="/assets/vendor/boxicons/css/boxicons.min.css"]')) {
    const boxiconsStyles = document.createElement('link');
    boxiconsStyles.rel = 'stylesheet';
    boxiconsStyles.href = 'assets/vendor/boxicons/css/boxicons.min.css?v=20261002-boxicons1';
    boxiconsStyles.dataset.relayBoxicons = 'true';
    document.head.appendChild(boxiconsStyles);
  }
  if (!document.querySelector('link[data-relay-boxicons-fallback]')) {
    const boxiconsFallback = document.createElement('link');
    boxiconsFallback.rel = 'stylesheet';
    boxiconsFallback.href = 'styles/boxicons-fallback.css?v=20261002-boxicons1';
    boxiconsFallback.dataset.relayBoxiconsFallback = 'true';
    document.head.appendChild(boxiconsFallback);
  }
  if (!document.querySelector('link[data-usability-pass]')) {
    const usabilityStyles = document.createElement('link');
    usabilityStyles.rel = 'stylesheet';
    usabilityStyles.href = 'styles/usability-pass.css?v=20261003-classic-colors2';
    usabilityStyles.dataset.usabilityPass = 'true';
    document.head.appendChild(usabilityStyles);
  }
  const pages = {
    main: [
      ['Browse skills', 'browse-skills.html'],
      ['Find a match', 'skill-matching.html'],
      ['Community', 'community.html'],
      ['Groups', 'groups.html'],
      ['Help center', 'help-center.html']
    ],
    // Curated from the latest extension-page batch; static page files do not expose release timestamps.
    newlyAdded: [
      ['Achievements', 'achievements.html'],
      ['Funding hub', 'funding-hub.html'],
      ['Learning journal', 'learning-journal.html'],
      ['Marketplace', 'marketplace.html'],
      ['Mentor dashboard', 'mentor-dashboard.html'],
      ['Moderation center', 'moderation-center.html'],
      ['Roadmap', 'roadmap.html'],
      ['Session rooms', 'session-room.html'],
      ['Skill battle', 'skill-battle.html'],
      ['Student safety', 'student-safety.html']
    ],
    platform: [
      ['Browse skills', 'browse-skills.html'],
      ['Skill matching', 'skill-matching.html'],
      ['Workshops', 'workshops.html']
    ],
    community: [
      ['Community', 'community.html'],
      ['Groups', 'groups.html'],
      ['Messages', 'notifications.html']
    ],
    learning: [
      ['Courses', 'courses.html'],
      ['Resources', 'resources.html'],
      ['Learning journal', 'learning-journal.html']
    ],
    professional: [
      ['Become a mentor', 'become-a-mentor.html'],
      ['Projects', 'projects.html'],
      ['Marketplace', 'marketplace.html']
    ],
    company: [
      ['About', 'about.html'],
      ['Help center', 'help-center.html'],
      ['Contact & support', 'contact.html'],
      ['Safety & reports', 'contact.html?type=safety']
    ],
    support: [
      ['Contact & support', 'contact.html'],
      ['Help center', 'help-center.html'],
      ['Safety & reports', 'contact.html?type=safety']
    ],
    account: [
      ['Dashboard', 'dashboard.html'],
      ['My profile', 'profile.html'],
      ['Inbox', 'notifications.html'],
      ['Calendar', 'calendar.html'],
      ['Log in', 'login.html'],
      ['Create account', 'register.html']
    ]
  };
  // The footer is the canonical site map. Keep every HTML route represented
  // here, including useful legacy aliases and protected workspaces, so a
  // visitor can always find the page they are looking for from any route.
  const footerSitemap = {
    'Explore & learn': [
      ['Home', 'index.html'],
      ['Browse skills', 'browse-skills.html'],
      ['Find a match', 'skill-matching.html?intent=swap'],
      ['How it works', 'how-it-works.html'],
      ['Skills & innovation', 'skill-innovation.html'],
      ['Skill assessments', 'skill-assessments.html'],
      ['Learning paths', 'learning-paths.html'],
      ['Courses', 'courses.html'],
      ['Resources', 'resources.html'],
      ['Workshops', 'workshops.html'],
      ['Events', 'events.html'],
      ['Live sessions', 'live-sessions.html'],
      ['Session room', 'session-room.html'],
      ['Video room', 'video-room.html'],
      ['Calendar', 'calendar.html'],
      ['Features', 'features.html']
    ],
    Community: [
      ['Community', 'community.html'],
      ['Member profile', 'member-profile.html'],
      ['Members directory', 'talent-directory.html'],
      ['Phonebook', 'phonebook.html'],
      ['Groups', 'groups.html'],
      ['Discussion forums', 'forums.html'],
      ['Livestreams', 'livestreams.html'],
      ['Messages', 'notifications.html'],
      ['Leaderboards', 'leaderboards.html'],
      ['Community challenges', 'community-challenges.html'],
      ['Skill battle', 'skill-battle.html'],
      ['Blog', 'blog.html'],
      ['Success stories', 'success-stories.html'],
      ['Achievements', 'achievements.html'],
      ['Learning journal', 'learning-journal.html']
    ],
    'Create & grow': [
      ['Projects', 'projects.html'],
      ['Marketplace', 'marketplace.html'],
      ['SwapLabs Tasks', 'swapjobs.html'],
      ['Become a mentor', 'become-a-mentor.html'],
      ['Mentor dashboard', 'mentor-dashboard.html'],
      ['Mentors', 'mentors.html'],
      ['Funding hub', 'funding-hub.html'],
      ['Donate', 'donate.html'],
      ['Partner with us', 'partner-with-us.html'],
      ['My portfolio', 'portfolio.html'],
      ['Gifts & vouchers', 'gifts.html'],
      ['Rewards', 'rewards.html'],
      ['Credit ledger', 'credits.html']
    ],
    Account: [
      ['Log in', 'login.html'],
      ['Create account', 'register.html'],
      ['Dashboard', 'dashboard.html'],
      ['My profile', 'profile.html']
    ],
    Company: [
      ['About', 'about.html'],
      ['Download SwapLabs', 'download.html'],
      ['Careers', 'careers.html'],
      ['Pricing', 'pricing.html'],
      ['Roadmap', 'roadmap.html'],
      ['Site credits', 'site-credits.html'],
      ['Privacy', 'privacy.html'],
      ['Terms', 'terms.html']
    ],
    'Support & workspaces': [
      ['Help center', 'help-center.html'],
      ['FAQ', 'faq.html'],
      ['Contact & support', 'contact.html'],
      ['Feedback', 'feedback.html'],
      ['Complaints', 'complaint.html'],
      ['Student safety', 'student-safety.html'],
      ['Safety report', 'report.html'],
      ['Admin gate', 'admin-gate.html'],
      ['Administration', 'admin.html'],
      ['Moderation center', 'moderation-center.html'],
      ['Organisation accounts', 'organization.html'],
      ['Organisation admin', 'organization-admin.html']
    ]
  };
  const footerSitemapPages = Object.keys(footerSitemap).reduce(
    (all, group) => all.concat(footerSitemap[group]), []
  );
  // Feed the complete sitemap into the global search index too. The visible
  // footer and the search menu should never disagree about what exists.
  pages.sitemap = footerSitemapPages;
  // Keep the internal page taxonomy available to the global search index.
  // These labels are no longer rendered as a separate Pages directory; the
  // visible navigation now exposes the primary sections directly.
  const categoryMeta = {
    main: ['Main', 'bx-home-alt-2'],
    newlyAdded: ['Newly added', 'bx-star'],
    platform: ['Platform', 'bx-grid-alt'],
    community: ['Community', 'bx-group'],
    learning: ['Learning', 'bx-book-open'],
    account: ['Account', 'bx-user-circle'],
    professional: ['Professional', 'bx-briefcase-alt-2'],
    company: ['Company', 'bx-buildings'],
    support: ['Support', 'bx-support'],
    sitemap: ['All pages', 'bx-sitemap']
  };
  const categoryOrder = ['main', 'newlyAdded', 'platform', 'community', 'learning', 'account', 'professional', 'company', 'support', 'sitemap'];
  const rawCurrent = location.pathname.split('/').pop() || 'index.html';
  const current = rawCurrent.includes('.') ? rawCurrent : `${rawCurrent}.html`;
  const currentHash = location.hash || '';
  const isHomePage = current === 'index.html';
  // Remove stale static fallbacks/cards from older pages now that the
  // standalone Media route has been retired. The shared navigation below
  // will render the supported Community route instead.
  document.querySelectorAll('a[href="media.html"]').forEach(link => {
    const container = link.closest('.rs-tool-card, .atlas-card, .phonebook-quick-card, .community-tool-card, .phonebook-link-list a');
    (container || link).remove();
  });
  const communityRoutes = new Set(['community.html', 'member-profile.html', 'notifications.html', 'groups.html', 'livestreams.html', 'forums.html']);
  // A page can intentionally appear in more than one navigation section.
  // Match hash-specific destinations more strongly than their base page so,
  // for example, Study lobby belongs to Find a match while the main Study
  // Together page belongs to Learn. This keeps one route from lighting up
  // two primary sections at once.
  const navHrefScore = href => {
    const [pathWithQuery, hashPart = ''] = String(href || '').split('#');
    const route = pathWithQuery.split('?')[0];
    const routeMatches = current === route || (route === 'community.html' && communityRoutes.has(current));
    if (!routeMatches) return 0;
    if (hashPart) return currentHash === `#${hashPart}` ? 3 : 0;
    return 1;
  };
  const socialLinks = [
    ['Instagram', 'https://www.instagram.com/swaplabs/', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle class="social-dot" cx="18" cy="6" r="1"/></svg>'],
    ['YouTube', 'https://www.youtube.com/@SwapLabs', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.3 3.6-6.3 3.6Z"/></svg>'],
    ['X', 'https://x.com/Swaplabsofficia', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.6 22H2.4l7.3-8.4L1.8 2h6.5l4.5 6.8L18.9 2Zm-1.1 18h1.7L7.3 3.9H5.5L17.8 20Z"/></svg>']
  ];
  const socialLinksMarkup = socialLinks.map(([label, href, icon]) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer" aria-label="SwapLabs on ${label}" title="SwapLabs on ${label}">${icon}<span class="sr-only">${label}</span></a>`
  ).join('');
  const iconMap = {
    'Browse skills': 'bx-search-alt',
    'Features': 'bx-sparkles',
    'Skill matching': 'bx-git-compare',
    'Learning paths': 'bx-map-alt',
    'Skill assessments': 'bx-check-square',
    'Live sessions': 'bx-video',
    'Livestreams': 'bx-broadcast',
    'Session rooms': 'bx-video-plus',
    'Member community': 'bx-user-find',
    'Media': 'bx-play-circle',
    'Messages': 'bx-message-square-dots',
    'Communities': 'bx-group',
    'Discussion forums': 'bx-conversation',
    'Groups': 'bx-group',
    'Leaderboards': 'bx-trophy',
    'Community challenges': 'bx-target-lock',
    'Skill battle': 'bx-bolt-circle',
    'Courses': 'bx-book-open',
    'Resources': 'bx-library',
    'Workshops': 'bx-chalkboard',
    'Learning journal': 'bx-notepad',
    'Achievements': 'bx-trophy',
    'Skills & innovation': 'bx-rocket',
    'Funding hub': 'bx-fund',
    'Become a mentor': 'bx-user-voice',
    'Mentor dashboard': 'bx-line-chart',
    'Members directory': 'bx-id-card',
    'Projects': 'bx-briefcase-alt-2',
    'Marketplace': 'bx-store',
    'SwapLabs Tasks': 'bx-briefcase-alt-2',
    'My portfolio': 'bx-id-card',
    'Partner with us': 'bx-buildings',
    'Blog': 'bx-news',
    'Events': 'bx-calendar-event',
    'Mentors': 'bx-user-check',
    'Success stories': 'bx-line-chart',
    'How it works': 'bx-list-check',
    'Pricing': 'bx-purchase-tag',
    'Roadmap': 'bx-map-pin',
    'FAQ': 'bx-help-circle',
    'About': 'bx-info-circle',
    'Careers': 'bx-briefcase',
    'Privacy': 'bx-lock-alt',
    'Terms': 'bx-file',
    'Help center': 'bx-support',
    'Contact us': 'bx-envelope',
    'Contact & support': 'bx-support',
    'Complaints': 'bx-message-square-error',
    'Feedback': 'bx-message-square-dots',
    'Feedback form': 'bx-message-square-dots',
    'Safety & reports': 'bx-shield-quarter',
    'Student safety': 'bx-shield-quarter',
    'Report': 'bx-flag',
    'Dashboard': 'bx-grid-alt',
    'Phonebook': 'bx-grid-alt',
    'My account': 'bx-user-circle',
    'Inbox & messages': 'bx-message-square-dots',
    'Meetings & calendar': 'bx-calendar-check',
    'Log in': 'bx-log-in',
    'Create account': 'bx-user-plus',
    'My profile': 'bx-user-circle',
    'Inbox': 'bx-message-square-dots',
    'Calendar': 'bx-calendar',
    'Credit ledger': 'bx-wallet',
    'Gifts & vouchers': 'bx-gift',
    'Administration': 'bx-shield-quarter',
    'Moderation center': 'bx-shield',
    'Study Together': 'bx-group',
    'Study lobby': 'bx-radar',
    'Study history': 'bx-history'
  };
  const navGroups = [
    {
      key: 'learn', label: 'Learn', icon: 'bx-book-open', href: 'browse-skills.html', className: 'nav-learn',
      description: 'Discover skills, practise consistently, and keep your progress moving.',
      items: [
        ['Study Together', 'study-together.html'], ['Features', 'features.html'], ['Browse skills', 'browse-skills.html'], ['Workshops', 'workshops.html'], ['Courses', 'courses.html'],
        ['Resources', 'resources.html'], ['Learning journal', 'learning-journal.html'],
        ['Skill assessments', 'skill-assessments.html'], ['Achievements', 'achievements.html']
      ]
    },
    {
      key: 'match', label: 'Find a match', icon: 'bx-transfer-alt', href: 'skill-matching.html?intent=swap', className: 'nav-match',
      description: 'Find a person, skill, or session that fits what you need next.',
      items: [
        ['Study lobby', 'study-together.html#lobby'], ['Skill matching', 'skill-matching.html'], ['Phonebook', 'phonebook.html'], ['Members directory', 'talent-directory.html'],
        ['Mentors', 'mentors.html'], ['Live sessions', 'live-sessions.html'], ['Session rooms', 'session-room.html']
      ]
    },
    {
      key: 'community', label: 'Community', icon: 'bx-group', href: 'community.html', className: 'nav-community',
      description: 'Meet people, share work, and keep useful conversations together.',
      items: [
        ['Community', 'community.html'], ['Groups', 'groups.html'], ['Messages', 'notifications.html'],
        ['Discussion forums', 'forums.html'], ['Events', 'events.html'], ['Livestreams', 'livestreams.html'], ['Leaderboards', 'leaderboards.html']
      ]
    },
    {
      key: 'create', label: 'Create', icon: 'bx-plus-circle', href: 'skill-innovation.html#submitIdea', className: 'nav-create',
      description: 'Publish an idea, offer a skill, or turn your work into an opportunity.',
      items: [
        ['Skills & innovation', 'skill-innovation.html'], ['Projects', 'projects.html'], ['Marketplace', 'marketplace.html'],
        ['SwapLabs Tasks', 'swapjobs.html'], ['Become a mentor', 'become-a-mentor.html'], ['Funding hub', 'funding-hub.html'],
        ['Partner with us', 'partner-with-us.html'], ['Organisation', 'organization.html']
      ]
    },
    {
      key: 'support', label: 'Support', icon: 'bx-support', href: 'help-center.html', className: 'nav-support',
      description: 'Get clear answers, contact the team, and find safety guidance.',
      items: [
        ['Help center', 'help-center.html'], ['Contact us', 'contact.html'], ['Complaints', 'complaint.html'],
        ['Feedback', 'feedback.html'], ['Student safety', 'student-safety.html'], ['Report', 'report.html'],
        ['How it works', 'how-it-works.html'], ['FAQ', 'faq.html'], ['Privacy', 'privacy.html'], ['Terms', 'terms.html'], ['Download SwapLabs', 'download.html']
      ]
    }
  ];
  const navGroupScore = group => Math.max(0, ...group.items.map(([, href]) => navHrefScore(href)));
  const activeNavGroup = navGroups.reduce((best, group) => {
    const score = navGroupScore(group);
    return score > best.score ? {group, score} : best;
  }, {group: null, score: 0}).group;
  const navGroupMarkup = group => {
    const groupActive = group === activeNavGroup ? 'active' : '';
    const strongestItemScore = navGroupScore(group);
    const links = group.items.map(([itemLabel, href]) =>
      `<a class="${navHrefScore(href) === strongestItemScore && strongestItemScore > 0 ? 'active' : ''}" href="${href}" role="menuitem"${navHrefScore(href) === strongestItemScore && strongestItemScore > 0 ? ' aria-current="page"' : ''}><i class="bx ${iconMap[itemLabel] || 'bx-right-arrow-alt'}" aria-hidden="true"></i><span>${itemLabel}</span><i class="bx bx-chevron-right" aria-hidden="true"></i></a>`
    ).join('');
    return `<div class="nav-hover-group ${group.className}" data-nav-group="${group.key}"><div class="nav-hover-trigger"><a class="nav-major ${group.className} ${groupActive}" href="${group.href}" aria-haspopup="true" aria-expanded="false"${groupActive ? ' aria-current="page"' : ''}><i class="bx ${group.icon}" aria-hidden="true"></i><span>${group.label}</span></a><button class="nav-group-toggle" type="button" aria-label="Show ${group.label} pages" aria-expanded="false"><i class="bx bx-chevron-down" aria-hidden="true"></i></button></div><div class="nav-hover-menu" role="menu" aria-label="${group.label} pages" aria-hidden="true"><div class="nav-hover-menu-head"><span>${group.items.length} pages</span><strong>${group.label}</strong><small>${group.description}</small></div><div class="nav-hover-links">${links}</div></div></div>`;
  };
  const navGroupsMarkup = navGroups.map(navGroupMarkup).join('');
  const navSearchMarkup = `<div class="nav-hover-group nav-search-group" data-nav-group="search"><div class="nav-hover-trigger"><a class="nav-major nav-search" href="browse-skills.html" aria-haspopup="true" aria-expanded="false" aria-label="Search SwapLabs"><i class="bx bx-search-alt" aria-hidden="true"></i><span class="nav-search-label">Search</span></a><button class="nav-group-toggle" type="button" aria-label="Open site search" aria-expanded="false"><i class="bx bx-chevron-down" aria-hidden="true"></i></button></div><div class="nav-hover-menu nav-search-menu" role="dialog" aria-label="Search SwapLabs" aria-hidden="true"><div class="nav-hover-menu-head"><span>Search every page</span><strong>Where do you want to go?</strong><small>Find pages, tools, and sections from across SwapLabs.</small></div><form class="nav-site-search" id="navSiteSearch" role="search" autocomplete="off"><label for="navSiteSearchInput"><i class="bx bx-search-alt" aria-hidden="true"></i><input id="navSiteSearchInput" type="search" placeholder="Search everything" aria-label="Search everything on SwapLabs" aria-controls="navSearchResults" aria-expanded="false"><button type="submit" aria-label="Open top search result"><i class="bx bx-right-arrow-alt" aria-hidden="true"></i></button></label><div class="nav-search-results" id="navSearchResults" role="listbox" hidden></div></form></div></div>`;
  const header = document.querySelector('[data-site-header]');
  if (header) window.RelayComponents.render(header,
    `<header class="site-header" data-enhanced-nav><div class="nav-ambient nav-ambient-one"></div><div class="nav-ambient nav-ambient-two"></div><div class="container nav"><a class="brand" href="index.html"><span class="brand-logo-shell"><img src="logo.jpg" alt="SwapLabs logo"><i class="brand-live-dot" aria-hidden="true"></i></span><span class="brand-wordmark" aria-label="SwapLabs"><span class="brand-wordmark-relay">Swap</span><span class="brand-wordmark-skills">Labs</span></span></a><nav class="nav-links" id="navLinks" aria-label="Primary navigation"></nav><div class="nav-actions"><div class="auth-nav" data-auth-nav><a class="btn auth-login-button" href="login.html" aria-label="Log in" title="Log in"><i class="bx bx-log-in" aria-hidden="true"></i><span class="auth-login-label">Log in</span></a><span class="auth-register-stack"><a class="btn btn-primary" href="register.html">Create account</a><a class="auth-org-link" href="organization.html">Register your organisation</a></span></div><button class="menu-btn" id="primaryMenuBtn" type="button" aria-label="Open primary navigation" aria-expanded="false" aria-controls="navLinks"><i class="bx bx-menu" aria-hidden="true"></i></button></div></div></header>`);

  const headerBrand = header?.querySelector('.site-header .brand');
  if (headerBrand) {
    headerBrand.href = 'index.html';
    headerBrand.setAttribute('aria-label', 'SwapLabs home');
  }
  header?.querySelectorAll('.auth-register-stack > a[href="register.html"]').forEach(link => {
    if (!link.querySelector('i')) link.insertAdjacentHTML('afterbegin', '<i class="bx bx-user-plus" aria-hidden="true"></i> ');
  });
  const mainContent = document.querySelector('main');
  if (mainContent && !mainContent.id) mainContent.id = 'main-content';
  if (mainContent && !document.querySelector('[data-skip-link]')) {
    document.body.insertAdjacentHTML('afterbegin', '<a class="skip-link" data-skip-link href="#main-content">Skip to main content</a>');
  }
  const focusedNav = document.querySelector('#navLinks');
  if (focusedNav) focusedNav.innerHTML =
    `${navGroupsMarkup}${navSearchMarkup}`;

  document.querySelectorAll('.nav-links a').forEach(link => {
    link.setAttribute('aria-label', link.textContent.trim());
    link.title = link.textContent.trim();
  });

  const footerSitemapIcons = {
    'Explore & learn': 'bx-compass',
    Community: 'bx-group',
    'Create & grow': 'bx-rocket',
    Account: 'bx-user-circle',
    Company: 'bx-buildings',
    'Support & workspaces': 'bx-support'
  };
  const sitemapCol = (title, items) =>
    `<section class="footer-sitemap-col"><h4><span class="footer-sitemap-col-icon"><i class="bx ${footerSitemapIcons[title] || 'bx-right-arrow-alt'}" aria-hidden="true"></i></span><span>${title}</span></h4><div class="footer-sitemap-link-list">${items.map(([label,href]) => `<a href="${href}"><span>${label}</span><i class="bx bx-chevron-right" aria-hidden="true"></i></a>`).join('')}</div></section>`;
  const footerSitemapMarkup =
    `<section class="footer-sitemap" aria-labelledby="footerSitemapTitle"><div class="footer-sitemap-head"><div><span class="footer-sitemap-kicker"><i class="bx bx-sitemap" aria-hidden="true"></i> Complete directory · ${footerSitemapPages.length} pages</span><h3 id="footerSitemapTitle">Every SwapLabs page, in one place.</h3><p>Explore learning, community, creation, account, support, and protected workspace routes from any page on the site.</p></div><a class="footer-sitemap-home" href="index.html">Back to home <i class="bx bx-right-arrow-alt" aria-hidden="true"></i></a></div><div class="footer-sitemap-grid">${Object.keys(footerSitemap).map(group => sitemapCol(group, footerSitemap[group])).join('')}</div></section>`;
  const getIstYear = () => {
    try {
      return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date());
    } catch (_error) {
      return String(new Date().getFullYear());
    }
  };
  const footer = document.querySelector('[data-site-footer]');
  if (footer) window.RelayComponents.render(footer, `<footer class="site-footer site-footer--compact"><div class="container footer-compact-shell">
      <div class="footer-compact-row">
        <div class="footer-compact-identity">
          <a class="brand footer-compact-brand" href="index.html" aria-label="SwapLabs home"><span class="brand-logo-shell"><img src="logo.jpg" alt=""></span><span class="brand-wordmark" aria-label="SwapLabs"><span class="brand-wordmark-relay">Swap</span><span class="brand-wordmark-skills">Labs</span></span></a>
          <span class="footer-compact-tagline">Learn Anything. Teach Everything.</span>
        </div>
        <div class="footer-compact-actions">
          <nav class="footer-social-links" aria-label="SwapLabs social media">${socialLinksMarkup}</nav>
          <a class="footer-directory-disclosure" href="phonebook.html" aria-label="Explore all SwapLabs pages in the Phonebook" title="Open Phonebook"><i class="bx bx-book-open" aria-hidden="true"></i><span>Explore</span><small>${footerSitemapPages.length} pages</small></a>
        </div>
      </div>
      <div class="footer-compact-content" aria-label="Popular SwapLabs pages">
        <div class="footer-compact-about"><span class="footer-compact-kicker">A place to share what you know</span><p>Meet people, exchange practical skills, and keep learning together.</p><a href="about.html">More about SwapLabs <i class="bx bx-right-arrow-alt" aria-hidden="true"></i></a><nav class="footer-compact-links" aria-label="Quick links"><a href="download.html">Download SwapLabs</a><a href="help-center.html">Help</a><a href="contact.html">Contact</a><a href="mailto:support.swaplabs@gmail.com">Email</a></nav></div>
        <nav class="footer-compact-column" aria-label="Explore learning"><h3>Explore</h3><a href="browse-skills.html">Browse skills</a><a href="skill-matching.html">Find a match</a><a href="courses.html">Courses</a><a href="workshops.html">Workshops</a></nav>
        <nav class="footer-compact-column" aria-label="Community links"><h3>Community</h3><a href="community.html">Community</a><a href="phonebook.html">Members directory</a><a href="groups.html">Groups</a><a href="forums.html">Discussion forums</a></nav>
        <nav class="footer-compact-column" aria-label="Company and support"><h3>Company & support</h3><a href="how-it-works.html">How it works</a><a href="help-center.html">Help center</a><a href="faq.html">Frequently asked questions</a><a href="contact.html">Contact us</a></nav>
      </div>
      <div class="footer-bottom"><span class="footer-copyright" data-ist-year>Copyright ${getIstYear()} SwapLabs. All rights reserved.</span><nav class="footer-legal" aria-label="Legal links"><a href="privacy.html">Privacy</a><a href="terms.html">Terms</a><a href="site-credits.html">Credits</a><a href="report.html">Report</a></nav></div>
    </div></footer>`);

  const updateIstCopyrightYear = () => {
    const year = getIstYear();
    document.querySelectorAll('[data-ist-year]').forEach(node => {
      node.textContent = `Copyright ${year} SwapLabs. All rights reserved.`;
    });
  };
  updateIstCopyrightYear();
  window.setInterval(updateIstCopyrightYear, 60 * 1000);

  // Keep the rendered header, footer, and browser chrome aligned with the
  // supplied SwapLabs brand asset, including legacy fallback markup.
  document.querySelectorAll('img[src*="relayskills-logo"]').forEach(mark => {
    mark.src = 'logo.jpg';
  });
  document.querySelectorAll('link[rel~="icon"]').forEach(icon => {
    icon.href = 'logo.jpg';
    icon.type = 'image/png';
  });


  if (!footer) {
    document.body.insertAdjacentHTML('beforeend',
      `<nav class="page-social-dock" aria-label="SwapLabs social media">${socialLinksMarkup}</nav>`);
  }
  document.body.insertAdjacentHTML('beforeend',
    '<button class="back-to-top" type="button" aria-label="Back to top" title="Back to top"><i class="bx bx-up-arrow-alt" aria-hidden="true"></i></button>');
  const backToTop = document.querySelector('.back-to-top');
  let previousScrollY = window.scrollY;
  const updateGlobalScrollState = () => {
    const scrollY = Math.max(0, window.scrollY);
    const awayFromTop = scrollY > 28;
    const enhancedNav = document.querySelector('[data-enhanced-nav]');
    enhancedNav?.classList.toggle('is-scrolled', awayFromTop);
    if (enhancedNav) {
      enhancedNav.dataset.scrollDirection = scrollY <= 28 ? 'top' : scrollY > previousScrollY + 4 ? 'down' : scrollY < previousScrollY - 4 ? 'up' : 'still';
    }
    previousScrollY = scrollY;
    backToTop?.classList.toggle('visible', scrollY > 420);
  };
  window.addEventListener('scroll', updateGlobalScrollState, {passive: true});
  updateGlobalScrollState();
  backToTop?.addEventListener('click', () => window.scrollTo({
    top: 0,
    behavior: document.documentElement.classList.contains('pref-reduced-motion') ||
      document.documentElement.classList.contains('relayskills-reduced-motion') ? 'auto' : 'smooth'
  }));

  function setupSupportPrompt() {
    if (!isHomePage || document.querySelector('[data-support-prompt-ready]')) return;
    const prompt = document.querySelector('#supportPrompt');
    if (!prompt) return;
    prompt.dataset.supportPromptReady = 'true';
    let showTimer = 0;
    const close = () => {
      window.clearTimeout(showTimer);
      prompt.hidden = true;
    };
    prompt.querySelectorAll('[data-support-close]').forEach(button => button.addEventListener('click', close));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !prompt.hidden) close();
    });
    window.addEventListener('swaplabs:auth-state', event => {
      window.clearTimeout(showTimer);
      prompt.hidden = true;
      // A cached hint may be stale (for example, after logging out in another
      // tab).  Only the server-confirmed event may open the donation prompt.
      if (!event.detail?.authenticated || event.detail?.cached) return;
      showTimer = window.setTimeout(() => {
        prompt.hidden = false;
        prompt.querySelector('[data-support-close]')?.focus();
      }, 900);
    });
  }
  setupSupportPrompt();

  const formatPlatformMetric = value => typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(undefined, {maximumFractionDigits: 1}) : 'No data yet';
  const applyPlatformMetrics = (metrics = {}, unavailable = false, stale = false) => {
    let incompatible = false;
    document.querySelectorAll('[data-live-summary], .expansion-stats').forEach(element => {
      element.classList.toggle('is-empty', unavailable);
    });
    document.querySelectorAll('[data-platform-metric]').forEach(element => {
      const key = element.dataset.platformMetric;
      const value = metrics[key];
      const invalid = !(typeof value === 'number' && Number.isFinite(value)) && !(key === 'feedback_rating' && value === null);
      incompatible = incompatible || invalid;
      element.classList.toggle('metric-unavailable', unavailable || invalid);
      // A failed request is different from a measured zero. Keep the surface
      // calm while the automatic retry is in progress.
      element.textContent = unavailable || invalid ? '—' : formatPlatformMetric(value);
    });
    const date = new Date(metrics.updated_at);
    document.querySelectorAll('[data-live-status]').forEach(element => {
      element.textContent = unavailable ? 'Community totals will appear as members publish profiles.'
        : incompatible ? 'Community totals are temporarily being refreshed.'
        : stale ? `Cached platform totals · ${Number.isNaN(date.getTime()) ? 'saved previously' : `Updated ${date.toLocaleTimeString()}`} · Refreshing in the background…`
        : `Recorded platform totals · ${Number.isNaN(date.getTime()) ? 'Updated now' : `Updated ${date.toLocaleTimeString()}`} · Refreshes periodically · Includes saved starter content.`;
    });
  };
  const metricsCacheKey = 'swaplabs-public-metrics-v2';
  const metricsCacheMaxAge = 24 * 60 * 60 * 1000;
  let lastMetricsSnapshot = null;
  let persistedMetricsSnapshot = false;
  const readMetricsSnapshot = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(metricsCacheKey) || 'null');
      if (!saved || !saved.metrics || Date.now() - Number(saved.saved_at || 0) > metricsCacheMaxAge) return null;
      return {metrics: saved.metrics, skill_names: Array.isArray(saved.skill_names) ? saved.skill_names : []};
    } catch (_error) { return null; }
  };
  const writeMetricsSnapshot = (metrics, skillNames) => {
    try { localStorage.setItem(metricsCacheKey, JSON.stringify({saved_at: Date.now(), metrics, skill_names: skillNames})); }
    catch (_error) { /* Cache is an optional acceleration only. */ }
  };
  const publishMetrics = (metrics, skillNames, stale = false, fromCache = false) => {
    lastMetricsSnapshot = {metrics, skill_names: skillNames};
    persistedMetricsSnapshot = fromCache;
    applyPlatformMetrics(metrics, false, stale);
    window.SwapLabsSkillNames = skillNames;
    window.dispatchEvent(new CustomEvent('swaplabs:metrics-updated', {detail: {...metrics, skill_names: skillNames}}));
  };
  let metricsRequest;
  let metricsPollingStarted = false;
  const ensureMetricsPolling = () => {
    if (metricsPollingStarted) return;
    metricsPollingStarted = true;
    setInterval(() => { if (!document.hidden) refreshPlatformMetrics(); }, 60_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPlatformMetrics(); });
  };
  const refreshPlatformMetrics = async () => {
    if (metricsRequest) return metricsRequest;
    ensureMetricsPolling();
    metricsRequest = (async () => {
    try {
      const response = await fetch('/api/platform/metrics', {
        credentials: 'omit', cache: 'no-store'
      });
      if (!response.ok) throw new Error('Metrics unavailable');
      const result = await response.json();
      if (!result.ok || !result.metrics) throw new Error('Invalid metrics');
      const skillNames = Array.isArray(result.skill_names) ? result.skill_names : [];
      publishMetrics(result.metrics || {}, skillNames);
      writeMetricsSnapshot(result.metrics || {}, skillNames);
      return result.metrics || {};
    } catch (_error) {
      if (persistedMetricsSnapshot && lastMetricsSnapshot) applyPlatformMetrics(lastMetricsSnapshot.metrics, false, true);
      else applyPlatformMetrics({}, true);
      return null;
    } finally {
      metricsRequest = null;
    }
    })();
    return metricsRequest;
  };
  window.SwapLabsMetrics = {
    refresh: refreshPlatformMetrics, apply: applyPlatformMetrics
  };
  window.addEventListener('swaplabs:profile-updated', () => {
    if (!document.hidden) window.setTimeout(() => refreshPlatformMetrics(), 0);
  });
  const cachedMetrics = readMetricsSnapshot();
  if (cachedMetrics) publishMetrics(cachedMetrics.metrics, cachedMetrics.skill_names, true, true);
  // The fallback keeps the helper usable in small embedded test documents
  // without querySelector; normal pages only fetch when they render metrics.
  const hasMetricTargets = typeof document.querySelector === 'function'
    ? Boolean(document.querySelector('[data-platform-metric], [data-live-status]')) : true;
  if (hasMetricTargets) refreshPlatformMetrics();

  const primaryMenuButton = document.getElementById('primaryMenuBtn');
  const primaryNav = document.getElementById('navLinks');
  const navGroupsRoot = [...document.querySelectorAll('[data-nav-group]')];
  const setPrimaryNavOpen = open => {
    primaryNav?.classList.toggle('open', open);
    primaryMenuButton?.setAttribute('aria-expanded', String(open));
    primaryMenuButton?.setAttribute('aria-label', open ? 'Close primary navigation' : 'Open primary navigation');
  };
  const setNavGroupOpen = (group, open) => {
    if (!group) return;
    if (open) navGroupsRoot.forEach(other => { if (other !== group) setNavGroupOpen(other, false); });
    group.classList.toggle('is-open', open);
    group.querySelectorAll('.nav-major, .nav-group-toggle').forEach(control => {
      control.setAttribute('aria-expanded', String(open));
    });
    group.querySelectorAll('.nav-hover-menu').forEach(menu => {
      menu.setAttribute('aria-hidden', String(!open));
    });
  };
  const closeNavGroups = () => navGroupsRoot.forEach(group => setNavGroupOpen(group, false));
  navGroupsRoot.forEach(group => {
    const toggle = group.querySelector('.nav-group-toggle');
    group.addEventListener('pointerenter', () => {
      // Hover menus are helpful on desktop, but they are disruptive inside
      // the compact drawer: moving across a row should not open a second
      // panel underneath the user's finger or pointer.
      if (window.innerWidth > 1100 && window.matchMedia?.('(hover: hover)').matches) {
        setNavGroupOpen(group, true);
      }
    });
    group.addEventListener('pointerleave', event => {
      if (!group.contains(event.relatedTarget) && !group.matches(':focus-within')) setNavGroupOpen(group, false);
    });
    group.addEventListener('focusin', () => {
      if (window.innerWidth > 1100) setNavGroupOpen(group, true);
    });
    group.addEventListener('focusout', event => {
      if (!group.contains(event.relatedTarget)) setNavGroupOpen(group, false);
    });
    toggle?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setNavGroupOpen(group, !group.classList.contains('is-open'));
    });
    group.querySelectorAll('.nav-hover-menu a').forEach(link => link.addEventListener('click', () => {
      setNavGroupOpen(group, false);
      setPrimaryNavOpen(false);
    }));
  });
  primaryMenuButton?.addEventListener('click', () => {
    closeNavGroups();
    setPrimaryNavOpen(!primaryNav?.classList.contains('open'));
  });
  primaryNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setPrimaryNavOpen(false)));
  document.addEventListener('click', event => {
    if (event.target.closest('[data-nav-group]')) return;
    closeNavGroups();
  });
  window.addEventListener('pagehide', closeNavGroups);
  window.addEventListener('pageshow', closeNavGroups);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const openGroup = navGroupsRoot.find(group => group.classList.contains('is-open'));
      if (openGroup) {
        setNavGroupOpen(openGroup, false);
        openGroup.querySelector('.nav-major')?.focus();
      } else {
        setPrimaryNavOpen(false);
      }
    }
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1180) setPrimaryNavOpen(false);
    if (window.innerWidth > 1100) closeNavGroups();
  });

  document.querySelectorAll('.icon-box').forEach((box, index) => {
    if (!box.querySelector('i')) box.innerHTML =
      `<i class="bx ${['bx-bulb','bx-book','bx-group','bx-shield'][index%4]}"></i>`;
  });

  const knowledge = [{
      title: 'Member dashboard',
      page: 'dashboard.html',
      keys: 'dashboard home portal upcoming session recommended match credit balance pending request recent message progress next action',
      answer: 'After login, the Dashboard brings together your upcoming sessions, explainable match recommendations, credit balance, pending requests, recent messages, learning-goal progress, and the most useful next action.'
    },
    {
      title: 'Browse skills',
      page: 'browse-skills.html',
      keys: 'browse search find skill teacher category level python design language',
      answer: 'Browse Skills lets you search active teachers by topic, category, and experience level, then request an exchange.'
    },
    {
      title: 'Skill matching',
      page: 'skill-matching.html',
      keys: 'match matching recommendation compatible personalized teach learn algorithm why score reliability proficiency timezone overlap style empty',
      answer: 'Skill Matching ranks real members across nine visible factors: skill fit, learning goal, teaching style, session format, timezone-aware availability, language, proficiency, session history, and reliability. Open “Why this match?” to inspect every point.'
    },
    {
      title: 'Learning paths',
      page: 'learning-paths.html',
      keys: 'path roadmap beginner intermediate advanced progress milestone',
      answer: "Learning Paths explains setting a learning goal and recording practice in the journal. No enrolled path or completed milestones are assumed."
    },
    {
      title: 'Skill assessments',
      page: 'skill-assessments.html',
      keys: 'assessment test quiz level beginner intermediate advanced score',
      answer: "This page offers one Python practice question, not an overall proficiency assessment or certificate."
    },
    {
      title: 'Live sessions',
      page: 'live-sessions.html',
      keys: 'live session video one on one group join schedule room',
      answer: 'Live Sessions lists one-to-one and group learning rooms. You can filter by topic, level, format, and start time, then reserve a place.'
    },
    {
      title: 'Livestreams',
      page: 'livestreams.html',
      keys: 'livestream livestreaming broadcast stream twitch youtube watch schedule host creator chat donate donation credits camera live milestone 30 minutes one hour',
      answer: 'Livestreams lets members schedule and host public broadcasts, start a live room, watch active streams, join the presence list, chat, and donate time credits. Hosts can earn 500 credits at 30 minutes and 2,000 credits at one hour, with higher milestones after that.'
    },
    {
      title: 'Gifts & vouchers',
      page: 'gifts.html',
      keys: 'gift gifts voucher vouchers redeem redeeming code share one time credits send transfer',
      answer: 'Gifts & vouchers let members spend time credits to create a shareable one-time code. Another signed-in member can enter the code once, and the exact credit amount is added to their balance.'
    },
    {
      title: 'SwapLabs Tasks',
      page: 'swapjobs.html',
      keys: 'swapjobs swap jobs task task exchange gig freelance poster website design offer proposal volunteer points portfolio match work done',
      answer: 'SwapLabs Tasks connects a real task with a skill offer in return. Post what you need, describe what you can give back, review explainable matches, accept a proposal, and confirm completion. Volunteer tasks award 25 portfolio points to the helper.'
    },
    {
      title: 'Portfolio builder',
      page: 'portfolio.html',
      keys: 'portfolio portfolio builder project projects showcase public private customize evidence case study skills points',
      answer: 'Portfolio Builder lets every member add project evidence, include completed SwapLabs Tasks, choose public or private visibility, customize the introduction and accent, and show only the sections they want the community to see.'
    },
    {
      title: 'Session rooms',
      page: 'session-room.html',
      keys: 'session room video waiting room attendance screen sharing connection quality join camera microphone',
      answer: 'Session Rooms shows your calendar sessions and connected video rooms. From there you can create or enter rooms with waiting-room admission, screen sharing, connection checks, and attendance confirmation.'
    },
    {
      title: 'How it works',
      page: 'how-it-works.html',
      keys: 'how works start profile exchange steps process',
      answer: 'Create a profile, list what you teach and want to learn, review matches, agree on a session, meet, confirm the time, and leave feedback.'
    },
    {
      title: 'Pricing',
      page: 'pricing.html',
      keys: 'price pricing cost free plan plus teams subscription pay',
      answer: "This build has no paid subscription or payment processor. Time credits are internal exchange units used for member exchanges and shareable one-time vouchers."
    },
    {
      title: 'Time-credit ledger',
      page: 'credits.html',
      keys: 'time credit wallet ledger hour earned teach spend balance payment refund correction dispute transfer',
      answer: 'The immutable Credit Ledger records every earning, member payment, refund, correction, and dispute. You can transfer credits and challenge an outgoing payment without altering its original record.'
    },
    {
      title: 'FAQ',
      page: 'faq.html',
      keys: 'faq question answer common help',
      answer: 'The FAQ covers cost, time credits, matching, local sessions, missed sessions, verification, and private groups.'
    },
    {
      title: 'Member login',
      page: 'login.html',
      keys: 'login log in sign in username email password account access',
      answer: 'Members can log in with either their username or email address plus their password. Administrator access uses a separate private ID and password.'
    },
    {
      title: 'Registration',
      page: 'register.html',
      keys: 'register registration sign up create account join member details',
      answer: 'Registration is one short form for your full name, username, email or phone number, password, and date of birth. Age is calculated automatically for the 3–120 eligibility range; profile details can be added later.'
    },
    {
      title: 'My profile',
      page: 'profile.html',
      keys: 'profile panel edit change name age country dob birthday personal identity learning details',
      answer: 'The Profile panel lets you update your name, age, date of birth, country, city, languages, work details, bio, skills, goals, availability, privacy settings, profile accent, and password. Saved changes appear across SwapLabs.'
    },
    {
      title: 'Website settings',
      page: 'profile.html#preferences',
      keys: 'settings preferences website appearance theme dark light accessibility contrast motion spacing navigation landing account controls',
      answer: 'Website settings control appearance, accessibility, navigation, content spacing, and the page that opens after login.'
    },
    {
      title: 'Administration',
      page: 'admin.html',
      keys: 'admin administrator panel annotate suspend delete verify credit manage account moderation',
      answer: 'The protected Administration panel lets the administrator review complete account records, add private annotations, verify profiles, adjust time credits, suspend or reactivate access, delete member accounts, and review the audit log.'
    },
    {
      title: 'Inbox and messaging',
      page: 'notifications.html',
      keys: 'notification message messaging chat conversation attachment typing read mute block report follow request accept decline delete unread alert inbox bot assistant SwapLabs ai',
      answer: 'The Inbox combines SwapBot account updates with private member conversations, attachments, typing and read states, mute controls, blocking, reporting, follow requests, and session scheduling.'
    },
    {
      title: 'Calendar and availability',
      page: 'calendar.html',
      keys: 'calendar availability timezone reminder schedule reschedule cancel google outlook ics export appointment meeting',
      answer: 'The Calendar stores sessions and workshop registrations, converts times across IANA timezones, sends SwapBot reminders, supports rescheduling and cancellation, and exports to Google Calendar, Outlook, or ICS.'
    },
    {
      title: 'Community',
      page: 'community.html',
      keys: 'community directory members people skills groups conversations workshops discussions meet connect',
      answer: 'Community is the people side of SwapLabs: search member profiles, browse skills, share community posts, join groups, open conversations, and plan workshops or exchanges.'
    },
    {
      title: 'Discussion forums',
      page: 'forums.html',
      keys: 'forum discussion question advice reply post knowledge',
      answer: "Forums lists recorded community groups. Open a group to see permitted discussions; no invented thread counts are shown."
    },
    {
      title: 'Groups',
      page: 'groups.html',
      keys: 'group club tribe community coding photography music design join',
      answer: 'Groups are interest-based communities for subjects such as coding, photography, music, design, languages, wellness, and local learning.'
    },
    {
      title: 'Leaderboards',
      page: 'leaderboards.html',
      keys: 'leaderboard ranking credits balance top members exchange power',
      answer: 'Leaderboards rank eligible public members by their current time-credit balance.'
    },
    {
      title: 'Community challenges',
      page: 'community-challenges.html',
      keys: 'challenge monthly collaborate goal entry team streak',
      answer: "This page points to the working Skill Battle board, where only saved challenges and entries are counted."
    },
    {
      title: 'Skill battle',
      page: 'skill-battle.html',
      keys: 'skill battle challenge submit entry like contest weekly proof practice',
      answer: 'Skill Battle is a friendly challenge board where members submit small finished pieces of work, like useful entries, and earn recognition through practice.'
    },
    {
      title: 'Blog',
      page: 'blog.html',
      keys: 'blog journal article story guide news writing publish upload photos videos likes comments',
      answer: 'Blog community is the long-form space for members to publish stories, lessons and build notes with photos or videos, then discuss them through likes and comments.'
    },
    {
      title: 'Events',
      page: 'events.html',
      keys: 'event festival meetup calendar rsvp community night',
      answer: "Events lists upcoming recorded workshops. Open Workshops to check availability and register."
    },
    {
      title: 'Mentors',
      page: 'mentors.html',
      keys: 'mentor teacher coach expert experienced top',
      answer: "The Mentors page shows public teaching profiles. Skills are self-reported, not independent certification."
    },
    {
      title: 'Success stories',
      page: 'success-stories.html',
      keys: 'success story outcome result member transformation',
      answer: "This page shows actual published site feedback with permission, not independently verified outcomes."
    },
    {
      title: 'Courses',
      page: 'courses.html',
      keys: 'course curriculum module lesson enroll structured cohort',
      answer: "You can now browse public courses or publish your own course from the Courses page. Add a title, a clear description, and at least one lesson; choose Public to make it discoverable or save it as a private draft first."
    },
    {
      title: 'Resources',
      page: 'resources.html',
      keys: 'resource tutorial guide template tool material download library',
      answer: "Resources links to working platform guides and contact. It does not claim an unconnected download library."
    },
    {
      title: 'Workshops',
      page: 'workshops.html',
      keys: 'workshop masterclass hands on instructor upcoming seat register reserve cancel',
      answer: 'Workshops are focused live learning experiences with practical exercises, transparent seat availability, searchable schedules, member hosts, and saved registrations.'
    },
    {
      title: 'Skills and innovation',
      page: 'skill-innovation.html',
      keys: 'innovation idea invention funding student young minds pitch support like comment save follow founder',
      answer: 'The Skills and Innovation Lab helps students and young creators publish world-changing ideas, explain funding needs, find collaborators, receive comments, earn community support, and follow idea owners.'
    },
    {
      title: 'Funding hub',
      page: 'funding-hub.html',
      keys: 'funding hub pledge support mentor pilot introduction money idea sponsor backing recognition',
      answer: 'Funding Hub records support offers for Innovation Lab ideas, including funding interest, mentoring, pilot access, introductions, and specialist skills.'
    },
    {
      title: 'Learning journal',
      page: 'learning-journal.html',
      keys: 'learning journal reflection notes progress confidence practice minutes next step portfolio',
      answer: 'Learning Journal saves your reflections, skills practiced, confidence, minutes, and next steps. Entries can stay private or become portfolio evidence.'
    },
    {
      title: 'Achievements',
      page: 'achievements.html',
      keys: 'achievement badge milestone streak certificate progress pin profile trophy',
      answer: 'Achievements calculates badges from real activity such as sessions, profile strength, journal entries, idea participation, marketplace activity, and challenge entries.'
    },
    {
      title: 'Become a mentor',
      page: 'become-a-mentor.html',
      keys: 'become mentor apply teach coach requirements mentor application',
      answer: 'The Become a Mentor page explains eligibility, review criteria, responsibilities, benefits, and the mentor application process.'
    },
    {
      title: 'Mentor dashboard',
      page: 'mentor-dashboard.html',
      keys: 'mentor dashboard teaching sessions workshops application earned credits students',
      answer: 'Mentor Dashboard shows your hosted sessions, workshops, marketplace offers, credits earned, and mentor application status.'
    },
    {
      title: 'Members directory',
      page: 'talent-directory.html',
      keys: 'members directory talent directory people find members skills suggested similar filters profile',
      answer: 'The Members Directory helps you browse active members, filter by skills and preferences, and see suggestions based on the public parts of your profile.'
    },
    {
      title: 'Projects',
      page: 'projects.html',
      keys: 'project collaborate teammate team apply portfolio build opportunity',
      answer: "Projects lists published innovation ideas and links to collaboration details. A proposal is not a guaranteed vacancy or funded project."
    },
    {
      title: 'Marketplace',
      page: 'marketplace.html',
      keys: 'marketplace buy sell offer template guide paid credits order seller purchase',
      answer: 'Marketplace lets members buy practical help, templates, guides, and sessions using time credits. Purchases create ledger entries and open a seller conversation.'
    },
    {
      title: 'Partner with us',
      page: 'partner-with-us.html',
      keys: 'partner school organization company community partnership team education',
      answer: "Send an enquiry through Contact to discuss possible collaboration. No existing partnerships or measured outcomes are claimed."
    },
    {
      title: 'About',
      page: 'about.html',
      keys: 'about mission values company relayskills',
      answer: 'SwapLabs is a student-built learning network that began with a question: why should useful learning depend on how much money someone has? Members bring different skills, so they trade time instead of money. Our mission remains to make practical learning accessible to anyone and everyone possible through equal time, useful trust, and human progress.'
    },
    {
      title: 'Careers',
      page: 'careers.html',
      keys: 'career job role hiring work team vacancy apply',
      answer: "SwapLabs is a student project. No vacancies are published; contact the creator for project enquiries."
    },
    {
      title: 'Privacy',
      page: 'privacy.html',
      keys: 'privacy data information collect delete export control',
      answer: 'The Privacy page explains information collection, use, sharing, retention, and member rights such as access, correction, export, and deletion.'
    },
    {
      title: 'Terms',
      page: 'terms.html',
      keys: 'terms rules policy eligibility conduct account legal',
      answer: 'The Terms page describes account eligibility, community conduct, time credits, session responsibility, content, suspension, and termination.'
    },
    {
      title: 'Help center',
      page: 'help-center.html',
      keys: 'help support article guide problem account assistance',
      answer: 'The Help Center organizes guidance for getting started, credits, trust and safety, matching, events, groups, and account support.'
    },
    {
      title: 'Contact us',
      page: 'contact.html',
      keys: 'contact email message support press partnership question response',
      answer: 'Use Contact Us for general questions, account support, workshops, partnerships, press, careers, accessibility, or education programs. Every message receives a reference number.'
    },
    {
      title: 'Complaints',
      page: 'complaint.html',
      keys: 'complaint complain resolution service issue appeal dissatisfaction account billing workshop member',
      answer: 'The Complaints page records formal service, account, workshop, billing, accessibility, or moderation concerns and asks what resolution would help. Safety emergencies belong on the Report page.'
    },
    {
      title: 'Feedback form',
      page: 'feedback.html',
      keys: 'feedback form testimonial review rating homepage belt quote experience suggestion',
      answer: 'Use Feedback to rate your experience and share a testimonial. With publication permission, your words are added to the rotating testimonial belt on the SwapLabs homepage.'
    },
    {
      title: 'Student safety',
      page: 'student-safety.html',
      keys: 'student safety guardian consent age minor private profile moderation child young account',
      answer: 'Student Safety explains age-aware safeguards: member-selected public or private profiles, guardian consent records, connection-aware messaging, and specialist review for student ideas.'
    },
    {
      title: 'Report',
      page: 'report.html',
      keys: 'report safety harassment fraud impersonation dispute no show inappropriate',
      answer: 'Use the confidential Report page for harassment, unsafe behavior, fraud, impersonation, missed sessions, credit disputes, or inappropriate content.'
    },
    {
      title: 'Moderation center',
      page: 'moderation-center.html',
      keys: 'moderation center admin report safety dispute student idea guardian mentor application review',
      answer: 'Moderation Center gives administrators a focused review desk for reports, disputes, student idea review, guardian-sensitive accounts, mentor applications, and audit activity.'
    },
    {
      title: 'Roadmap',
      page: 'roadmap.html',
      keys: 'roadmap upcoming feature vote suggestion planned in progress shipped',
      answer: 'Roadmap lets members vote on upcoming SwapLabs features, suggest improvements, and follow public platform progress.'
    }
  ];
  // The directory is intentionally assembled lazily. The first paint stays
  // light, while the search field can still discover every route, section,
  // heading, and meaningful action across the static site.
  const searchablePagePaths = [
    'about.html', 'achievements.html', 'admin-gate.html', 'admin.html',
    'become-a-mentor.html', 'blog.html', 'browse-skills.html', 'calendar.html',
    'careers.html', 'community-challenges.html',
    'community.html', 'complaint.html', 'contact.html', 'courses.html',
    'credits.html', 'dashboard.html', 'donate.html',
    'events.html', 'faq.html', 'feedback.html', 'forums.html', 'funding-hub.html',
    'gifts.html', 'groups.html', 'help-center.html', 'how-it-works.html',
    'index.html', 'leaderboards.html', 'learning-journal.html',
    'learning-paths.html', 'live-sessions.html', 'livestreams.html', 'login.html',
    'marketplace.html', 'member-profile.html', 'mentor-dashboard.html',
    'mentors.html', 'moderation-center.html', 'notifications.html',
    'organization-admin.html', 'organization.html', 'partner-with-us.html',
    'phonebook.html', 'portfolio.html', 'pricing.html',
    'privacy.html', 'profile.html', 'projects.html', 'register.html', 'report.html',
    'resources.html', 'rewards.html', 'roadmap.html', 'session-room.html',
    'site-credits.html', 'skill-assessments.html', 'skill-battle.html',
    'skill-innovation.html', 'skill-matching.html', 'student-safety.html',
    'success-stories.html', 'swapjobs.html', 'talent-directory.html',
    'terms.html', 'video-room.html', 'workshops.html'
  ];
  const normalize = text => text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const assistantStopWords = new Set([
    'a', 'about', 'an', 'and', 'are', 'can', 'do', 'does', 'for', 'from', 'give', 'how', 'i', 'is',
    'it', 'me', 'my', 'of', 'on', 'or', 'please', 'should', 'show', 'tell', 'the', 'this', 'to',
    'what', 'where', 'which', 'with', 'you', 'your'
  ]);
  const assistantPageAliases = [
    {pattern: /\b(?:sign\s*up|signup|create\s+(?:an?\s+)?account|registration|register|join\s+SwapLabs)\b/i, page: 'register.html'},
    {pattern: /\b(?:sign\s*in|login|log\s*in|logged\s+in|password)\b/i, page: 'login.html'},
    {pattern: /\b(?:match|matching|mach|macth|find\s+(?:a\s+)?(?:teacher|learner|person|mach|match)|exchange\s+partner)\b/i, page: 'skill-matching.html'},
    {pattern: /\b(?:profile\s+photo|profile\s+picture|avatar|my\s+profile|profile)\b/i, page: 'profile.html'},
    {pattern: /\b(?:credit|credits|time\s+bank|wallet|balance|voucher|gift)\b/i, page: 'credits.html'},
    {pattern: /\b(?:calendar|schedule|availability|reminder|appointment)\b/i, page: 'calendar.html'},
    {pattern: /\b(?:message|messages|chat|inbox|conversation)\b/i, page: 'notifications.html'},
    {pattern: /\b(?:photo|photos|video|videos|reel|reels|shorts|gallery|media)\b/i, page: 'community.html'},
    {pattern: /\b(?:group|groups|community\s+group|club)\b/i, page: 'groups.html'},
    {pattern: /\b(?:course|courses|lesson|curriculum)\b/i, page: 'courses.html'},
    {pattern: /\b(?:workshop|workshops|masterclass)\b/i, page: 'workshops.html'},
    {pattern: /\b(?:safety|unsafe|harass|fraud|report)\b/i, page: 'report.html'},
    {pattern: /\b(?:member|members|directory|teacher|learner|people)\b/i, page: 'talent-directory.html'}
  ];
  const assistantPageContextCopy = {
    'community.html': 'You are on Community. Search members, compare skills, open profiles, join groups, and start useful conversations.',
    'notifications.html': 'You are in Chats. Choose a member conversation or SwapBot, then message, attach a file, or schedule a session.',
    'calendar.html': 'You are on Calendar. Review upcoming sessions, set availability, create reminders, and export events to your calendar app.',
    'skill-matching.html': 'You are on Skill Matching. Tell SwapLabs what you can teach and what you want to learn, then review why each suggestion fits.',
    'profile.html': 'You are on your Profile. Keep your identity, location, languages, skills, learning goal, and privacy settings up to date.',
    'dashboard.html': 'You are on the Dashboard. Check your next action, upcoming sessions, match suggestions, messages, and credit balance.'
  };
  const assistantStepsByPage = {
    'register.html': ['Open Create account.', 'Enter your identity, contact, password, and date of birth.', 'Accept the terms and finish the short profile setup.'],
    'skill-matching.html': ['List at least one skill you can teach and one you want to learn.', 'Choose your format, timing, and goal.', 'Open “Why this match?” before requesting an exchange.'],
    'profile.html': ['Complete country, language, teaching, learning, and goal details.', 'Review your privacy and safety preferences.', 'Save the profile so matching and member actions can use it.'],
    'calendar.html': ['Open Calendar from the navigation.', 'Choose a session time and timezone.', 'Save the event or export it to Google Calendar, Outlook, or ICS.'],
    'credits.html': ['Open Credit Ledger to see the balance and immutable entries.', 'Teach or complete an exchange to earn credits.', 'Use a transfer or voucher only after checking the recipient and amount.'],
    'groups.html': ['Search by a topic or interest.', 'Open a group to read its description and activity.', 'Join or start a conversation when the group feels appropriate.'],
    'notifications.html': ['Choose SwapBot or a member conversation.', 'Write a message or attach a supported file.', 'Use the calendar button when the conversation is ready for a session.']
  };
  const distance = (a, b) => {
    const row = Array.from({
      length: b.length + 1
    }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = old
      }
    }
    return row[b.length]
  };
  const fuzzyWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && distance(a, b) <= 2) || (Math.min(a
    .length, b.length) >= 3 && distance(a, b) <= 1);
  const knowledgeByPage = new Map(knowledge.map(item => [String(item.page || '').split(/[?#]/)[0], item]));
  const assistantQueryWords = query => [...new Set(normalize(query).split(' ').filter(word => word.length > 1 && !assistantStopWords.has(word)))];
  const assistantScore = (item, query) => {
    const clean = normalize(query), words = assistantQueryWords(query), title = normalize(item.title),
      titleWords = title.split(' ').filter(Boolean), keys = normalize(item.keys), keyWords = keys.split(' ').filter(Boolean);
    let score = 0;
    if (!clean || !title) return 0;
    if (clean === title) score += 180;
    if (clean.includes(title)) score += 100;
    titleWords.forEach(word => {
      if (clean.includes(word)) score += 34;
      else if (words.some(queryWord => fuzzyWord(queryWord, word))) score += 16;
    });
    words.forEach(word => {
      if (titleWords.includes(word)) score += 30;
      else if (keyWords.includes(word)) score += 14;
      else if (keys.includes(word)) score += 5;
      else if (keyWords.some(key => fuzzyWord(word, key))) score += 5;
    });
    if (/\b(?:how|step|start|begin|use|open|where)\b/.test(clean) && /\b(?:guide|how|lets|allows|helps|page)\b/.test(normalize(item.answer))) score += 4;
    return score;
  };
  const rankKnowledge = query => knowledge.map(item => ({...item, score: assistantScore(item, query)}))
    .filter(item => item.score > 0)
    .sort((first, second) => second.score - first.score || first.title.localeCompare(second.title));
  const relatedKnowledge = item => {
    const relatedPages = {
      'skill-matching.html': ['browse-skills.html', 'talent-directory.html', 'profile.html'],
      'profile.html': ['dashboard.html', 'skill-matching.html'],
      'credits.html': ['gifts.html', 'calendar.html'],
      'groups.html': ['community.html', 'forums.html'],
      'calendar.html': ['session-room.html', 'notifications.html'],
      'courses.html': ['learning-paths.html', 'learning-journal.html'],
      'notifications.html': ['calendar.html', 'talent-directory.html']
    }[item?.page] || [];
    return relatedPages.map(page => knowledgeByPage.get(page)).filter(Boolean);
  };
  const followupsFor = item => ({
    'skill-matching.html': ['What should I add to my profile?', 'Show the member directory'],
    'profile.html': ['What profile details unlock matching?', 'How do I update my privacy settings?'],
    'credits.html': ['How do I earn credits?', 'Show my credit balance'],
    'calendar.html': ['How do I schedule a session?', 'Remind me to review my calendar tomorrow at 7pm'],
    'groups.html': ['How do I find the right group?', 'Show Community'],
    'notifications.html': ['How do I schedule a session?', 'How do I report unsafe activity?'],
    'courses.html': ['Show Learning Paths', 'How do I publish a course?']
  }[item?.page] || ['What should I do next?', 'Show me the Help Center']);
  const buildKnowledgeGuide = (item, related = [], options = {}) => {
    const unique = [item, ...related].filter((candidate, index, list) => candidate && list.findIndex(entry => entry.page === candidate.page) === index);
    const links = unique.slice(0, 3).map(candidate => ({
      title: candidate.title,
      href: candidate.page,
      section: candidate.page === item.page ? 'Best next step' : 'Related',
      answer: candidate.answer,
      icon: iconMap[candidate.title] || 'bx-right-arrow-alt'
    }));
    const steps = options.steps || assistantStepsByPage[item.page];
    const answer = steps ? `${item.answer}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : item.answer;
    return {
      title: item.title,
      page: item.page,
      links,
      followups: options.followups || followupsFor(item),
      confidence: options.confidence || .96,
      answer
    };
  };
  const currentPageGuide = (page = current) => {
    const item = knowledgeByPage.get(String(page || current).split(/[?#]/)[0]);
    if (!item) return null;
    return buildKnowledgeGuide(item, [], {
      confidence: .99,
      steps: assistantStepsByPage[item.page]
    });
  };
  const overviewGuide = {
    title: 'SwapLabs overview',
    page: 'index.html',
    links: [
      {title: 'Browse skills', href: 'browse-skills.html', section: 'Start here', icon: 'bx-search-alt'},
      {title: 'Skill matching', href: 'skill-matching.html', section: 'Start here', icon: 'bx-git-compare'},
      {title: 'Community', href: 'community.html', section: 'Start here', icon: 'bx-group'}
    ],
    followups: ['How does matching work?', 'How do time credits work?', 'Show me the Community page'],
    confidence: .72,
    answer: 'SwapLabs helps people teach practical skills, learn from one another, find a good exchange partner, meet safely, and keep the work in one place. Ask about a page, a feature, or your own next step.'
  };
  const lookup = (query, context = {}) => {
    const clean = normalize(query), words = clean.split(' ').filter(Boolean);
    if (!words.length) return overviewGuide;
    if (/^(?:hi|hello|hey|good (?:morning|afternoon|evening))(?: there)?(?: swapbot)?$/.test(clean)) return {
      ...overviewGuide,
      title: 'Welcome to SwapLabs',
      confidence: 1,
      answer: 'Hi — I’m SwapBot. I can explain features, point you to the right page, and help you decide what to do next.'
    };
    if (/\b(?:what can you do|how can you help|who are you|what are you)\b/.test(clean)) return {
      ...overviewGuide,
      title: 'What SwapBot can do',
      answer: 'I can explain SwapLabs features, find the best page for a task, compare options, give short steps, use this page as context, and answer questions about your profile when you are signed in.'
    };
    if (/\b(?:what can i do here|what do i do here|what(?:'s| is) this page|how does this page work|where am i|what(?:'s| is) available here)\b/.test(clean)) {
      return currentPageGuide() || overviewGuide;
    }
    const compare = clean.match(/\bcompare\b\s+(?:these\s+)?(?:options\s+for\s+me\s*:\s*)?(.+)/);
    if (compare) {
      const parts = compare[1].split(/\s+(?:and|versus|vs|or)\s+/).map(part => part.trim()).filter(Boolean).slice(0, 3);
      const compared = parts.map(part => rankKnowledge(part)[0]).filter(Boolean).filter((item, index, list) => list.findIndex(entry => entry.page === item.page) === index);
      if (compared.length >= 2) {
        return {
          title: `Comparing ${compared[0].title} and ${compared[1].title}`,
          page: compared[0].page,
          links: compared.map(item => ({title: item.title, href: item.page, section: 'Compared option', answer: item.answer, icon: iconMap[item.title] || 'bx-right-arrow-alt'})),
          followups: ['Which one should I start with?', 'Show me the steps'],
          confidence: .98,
          answer: `${compared.map(item => `${item.title}: ${item.answer}`).join('\n\n')}\n\nIn short: choose the first option when you want to ${compared[0].answer.replace(/^[^.!?]+[.!?]?\s*/, '').toLowerCase()}`
        };
      }
    }
    const directPage = assistantPageAliases.find(alias => alias.pattern.test(query));
    const ranked = rankKnowledge(query);
    const best = directPage ? knowledgeByPage.get(directPage.page) : ranked[0];
    const bestScore = directPage ? 999 : best?.score || 0;
    const stepIntent = /\b(?:steps?|step by step|walk me through|how do i|how can i|show me how|instructions?)\b/.test(clean);
    if (best && bestScore >= 24) return buildKnowledgeGuide(best, relatedKnowledge(best), stepIntent ? {
      steps: assistantStepsByPage[best.page] || [`Open ${best.title}.`, best.answer, `Use the page actions to continue, or ask SwapBot about a specific control.`],
      confidence: assistantStepsByPage[best.page] ? .98 : .78,
      followups: followupsFor(best)
    } : {});
    return overviewGuide;
  };

  window.SwaplabsAssistant = {
    lookup
  };
  const escapeText = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  } [character]));
  const enrichSearchRecord = item => {
    const rawCategories = item.categories instanceof Set ? [...item.categories] : Array.isArray(item.categories) ? item.categories : item.categories ? [item.categories] : [],
      categories = [...new Set(rawCategories.filter(Boolean))],
      normalizedTitle = normalize(String(item.title || '')),
      normalizedPage = normalize(String(item.page || '')),
      haystack = normalize(`${item.title || ''} ${item.page || ''} ${item.section || ''} ${item.kind || ''} ${item.keys || ''} ${item.answer || ''} ${categories.join(' ')}`),
      uniqueWords = [...new Set(haystack.split(' ').filter(Boolean))];
    return {
      ...item,
      categories,
      normalizedTitle,
      normalizedPage,
      titleWords: normalizedTitle.split(' ').filter(Boolean),
      pageWords: normalizedPage.split(' ').filter(Boolean),
      haystack,
      haystackWords: uniqueWords
    };
  };
  let searchRecords = (() => {
    const records = new Map();
    categoryOrder.forEach(categoryKey => {
      const [categoryLabel] = categoryMeta[categoryKey];
      pages[categoryKey].forEach(([title, page]) => {
        const existing = records.get(page) || {
          title,
          page,
          keys: '',
          answer: `Open ${title.toLowerCase()} on SwapLabs.`,
          categories: new Set()
        };
        existing.categories.add(categoryLabel);
        existing.keys = `${existing.keys} ${title} ${page} ${categoryLabel}`;
        records.set(page, existing);
      });
    });
    knowledge.forEach(item => {
      const existing = records.get(item.page) || {
        title: item.title,
        page: item.page,
        keys: '',
        answer: item.answer,
        categories: new Set()
      };
      existing.title = item.title;
      existing.answer = item.answer;
      existing.keys = `${existing.keys} ${item.keys} ${item.title} ${item.page} ${item.answer}`;
      records.set(item.page, existing);
    });
    return [...records.values()].map(enrichSearchRecord);
  })();
  const searchCache = new Map();
  const searchRecordKey = item => [item.page, item.title, item.section || '', item.kind || ''].map(value => String(value || '').toLowerCase()).join('|');
  const searchSnippet = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const searchAnchorSlug = value => normalize(String(value || '')).replace(/\s+/g, '-').slice(0, 54) || 'section';
  const ensureSearchAnchors = root => {
    if (!root) return [];
    const used = new Set([...root.querySelectorAll('[id]')].map(node => node.id).filter(Boolean));
    const sectionIds = new Map();
    return [...root.querySelectorAll('h1,h2,h3,h4')].map((heading, index) => {
      const section = heading.closest('section,article,form,fieldset') || heading;
      if (!section) return '';
      if (sectionIds.has(section)) return sectionIds.get(section);
      let id = section.id || `site-search-${searchAnchorSlug(heading.textContent)}`;
      let suffix = 2;
      while (used.has(id) && section.id !== id) id = `site-search-${searchAnchorSlug(heading.textContent)}-${suffix++}`;
      if (!section.id) section.id = id;
      used.add(id);
      sectionIds.set(section, id);
      return id;
    });
  };
  const resolveSearchHref = (href, pagePath) => {
    const raw = String(href || '').trim();
    if (!raw || /^(?:javascript:|mailto:|tel:|data:)/i.test(raw)) return '';
    try {
      const base = new URL(pagePath, location.href), target = new URL(raw, base);
      if (target.origin !== location.origin) return '';
      const file = target.pathname.split('/').filter(Boolean).pop() || pagePath;
      return `${file}${target.search}${target.hash}`;
    } catch (_error) {
      return '';
    }
  };
  const extractPageSearchRecords = (html, pagePath) => {
    const doc = new DOMParser().parseFromString(html, 'text/html'),
      root = doc.querySelector('main') || doc.body;
    if (!root) return [];
    const pageTitle = searchSnippet(root.querySelector('h1')?.textContent || doc.title || pagePath) || pagePath,
      description = searchSnippet(doc.querySelector('meta[name="description"]')?.content || root.textContent),
      headings = [...root.querySelectorAll('h1,h2,h3,h4')],
      headingAnchors = ensureSearchAnchors(root),
      headingIds = new Map(headings.map((heading, index) => [heading, headingAnchors[index] || ''])),
      records = [{
        title: pageTitle,
        page: pagePath,
        section: 'Page overview',
        kind: 'page',
        keys: `${pageTitle} ${pagePath} ${description}`,
        answer: description || `Open ${pageTitle.toLowerCase()} on SwapLabs.`
      }];
    const contextFor = node => {
      const semanticScope = node.closest('section,article,form,fieldset'),
        parentScope = node.parentElement,
        scope = semanticScope || parentScope || root,
        candidates = [semanticScope?.textContent, parentScope?.textContent, node.nextElementSibling?.textContent, node.previousElementSibling?.textContent],
        rawContext = candidates.find(value => String(value || '').trim().length > 0 && String(value).length <= 720) || candidates.find(value => String(value || '').trim().length > 0) || root.textContent,
        heading = semanticScope?.querySelector?.('h1,h2,h3,h4') || parentScope?.querySelector?.('h1,h2,h3,h4');
      return {
        scope,
        section: searchSnippet(heading?.textContent) || pageTitle,
        context: searchSnippet(rawContext) || pageTitle
      };
    };
    headings.forEach(heading => {
      const title = searchSnippet(heading.textContent);
      if (title.length < 2) return;
      const {context} = contextFor(heading), id = headingIds.get(heading), target = id ? `${pagePath}#${id}` : pagePath;
      records.push({
        title,
        page: target,
        section: title,
        kind: 'section',
        keys: `${title} ${pageTitle} ${context}`,
        answer: context
      });
    });
    const seenActions = new Set();
    [...root.querySelectorAll('a[href],button')].forEach(action => {
      const label = searchSnippet(action.innerText || action.textContent);
      if (label.length < 3 || label.length > 110 || /^(?:close|menu|next|previous|open menu|toggle)$/i.test(label)) return;
      const {section, context} = contextFor(action),
        heading = action.closest('section,article,form,fieldset')?.querySelector('h1,h2,h3,h4'),
        id = heading ? headingIds.get(heading) : '',
        href = action.matches('a[href]') ? resolveSearchHref(action.getAttribute('href'), pagePath) : id ? `${pagePath}#${id}` : pagePath,
        key = `${label.toLowerCase()}|${href}`;
      if (!href || seenActions.has(key)) return;
      seenActions.add(key);
      records.push({
        title: label,
        page: href,
        section,
        kind: 'action',
        keys: `${label} ${pageTitle} ${section} ${context} ${href}`,
        answer: context
      });
    });
    return records;
  };
  const mergeSearchRecords = incoming => {
    const merged = new Map(searchRecords.map(item => [searchRecordKey(item), item]));
    incoming.forEach(item => {
      const key = searchRecordKey(item), existing = merged.get(key);
      if (existing) {
        existing.keys = `${existing.keys || ''} ${item.keys || ''}`;
        if ((item.answer || '').length > (existing.answer || '').length) existing.answer = item.answer;
      } else {
        merged.set(key, item);
      }
    });
    searchRecords = [...merged.values()].map(enrichSearchRecord);
    searchCache.clear();
  };
  let fullSearchIndexReady = false;
  let fullSearchIndexPromise = null;
  const ensureFullSearchIndex = () => {
    if (fullSearchIndexReady) return Promise.resolve();
    if (fullSearchIndexPromise) return fullSearchIndexPromise;
    fullSearchIndexPromise = (async () => {
      const allRecords = [];
      for (let index = 0; index < searchablePagePaths.length; index += 8) {
        const batch = searchablePagePaths.slice(index, index + 8), results = await Promise.all(batch.map(async pagePath => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          try {
            const response = await fetch(pagePath, {credentials: 'same-origin', cache: 'force-cache', signal: controller.signal});
            return response.ok ? extractPageSearchRecords(await response.text(), pagePath) : [];
          } catch (_error) {
            return [];
          } finally {
            clearTimeout(timeout);
          }
        }));
        results.forEach(records => allRecords.push(...records));
      }
      mergeSearchRecords(allRecords);
      fullSearchIndexReady = true;
      if (navSearchInput?.value.trim()) renderNavSearch();
    })().catch(() => {
      // The base directory index remains useful if a host blocks one or more
      // static pages from being fetched.
    }).finally(() => {
      fullSearchIndexPromise = null;
    });
    return fullSearchIndexPromise;
  };
  ensureSearchAnchors(document.querySelector('main') || document.body);
  const wordMatches = (word, candidates, allowFuzzy = true) => candidates.some(candidate => candidate === word ||
    (candidate.length >= 3 && word.length >= 3 && (candidate.includes(word) || word.includes(candidate))) ||
    (allowFuzzy && Math.min(candidate.length, word.length) >= 3 && Math.abs(candidate.length - word.length) <= 2 && fuzzyWord(
      word, candidate)));
  const searchSite = query => {
    const clean = normalize(query),
      words = clean.split(' ').filter(Boolean);
    if (!words.length) return [];
    if (searchCache.has(clean)) return searchCache.get(clean);
    const scored = searchRecords.map(item => {
      let score = 0;
      if (item.normalizedTitle === clean || item.normalizedPage === clean) score += 90;
      if (clean.includes(item.normalizedTitle) || clean.includes(item.normalizedPage)) score += 45;
      if (item.haystack.includes(clean)) score += 24;
      words.forEach(word => {
        if (wordMatches(word, item.titleWords)) score += 12;
        if (wordMatches(word, item.pageWords)) score += 10;
        if (wordMatches(word, item.haystackWords, false)) score += 3;
      });
      const allWordsMatch = words.every(word => wordMatches(word, item.haystackWords, false) || wordMatches(word,
        item.titleWords) || wordMatches(word, item.pageWords));
      if (allWordsMatch) score += 18;
      return {
        ...item,
        score
      };
    });
    const results = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    searchCache.set(clean, results);
    return results;
  };
  const guideFromSearch = (query, context = {}) => {
    const curated = lookup(query, context);
    if (curated.title !== overviewGuide.title || curated.page !== overviewGuide.page) return curated;
    const results = searchSite(query);
    const usefulResults = results.filter(result => result.score >= 18 && result.kind !== 'action')
      .filter((result, index, list) => list.findIndex(item => item.page === result.page) === index);
    if (!usefulResults.length) {
      if (curated.title !== overviewGuide.title) return curated;
      return {
        title: 'I could not find an exact match',
        page: 'help-center.html',
        links: [
          {title: 'Help Center', href: 'help-center.html', section: 'Browse help topics', icon: 'bx-help-circle'},
          {title: 'Frequently asked questions', href: 'faq.html', section: 'Common questions', icon: 'bx-message-square-detail'},
          {title: 'Contact support', href: 'contact.html', section: 'Ask the team', icon: 'bx-support'}
        ],
        followups: ['How does matching work?', 'How do time credits work?', 'What can SwapBot do?'],
        confidence: .35,
        answer: `I could not match “${String(query || '').trim().slice(0, 120)}” to a specific SwapLabs feature, so I do not want to guess. Try asking about matching, courses, groups, messages, Calendar, credits, profiles, or safety.`
      };
    }
    const links = usefulResults.slice(0, 3).map(result => ({
      title: result.title,
      href: result.page,
      section: result.section || result.categories?.[0] || 'SwapLabs',
      answer: result.answer,
      icon: iconMap[result.title] || 'bx-right-arrow-alt'
    }));
    const best = usefulResults[0];
    return {
      title: best.title,
      page: best.page,
      links,
      followups: usefulResults.slice(1, 3).map(result => `Show ${result.title}`),
      confidence: .84,
      answer: `I found ${best.title}. ${best.answer || `Open ${best.title} to continue.`}`
    };
  };
  window.SwaplabsAssistant.lookup = guideFromSearch;
  let assistantContextRequest;
  const getAssistantUser = async () => {
    if (assistantContextRequest) return assistantContextRequest;
    assistantContextRequest = Promise.resolve(window.SwapLabsAuth?.get?.())
      .then(result => result?.authenticated ? result.user : null)
      .catch(() => null)
      .finally(() => { assistantContextRequest = null; });
    return assistantContextRequest;
  };
  const assistantList = value => {
    const values = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(values.map(item => String(item || '').trim()).filter(item => item && item.toLowerCase() !== 'nothing for now'))];
  };
  const contextualLookup = async (query, context = {}) => {
    const base = guideFromSearch(query, context);
    const clean = normalize(query);
    const personalIntent = /\b(?:my|account|profile|balance)\b|\bwhat do i teach\b|\bwhat am i learning\b/i.test(clean);
    const guideIntent = /\b(?:guide me|show me around|getting started|new here|not sure (?:where|what|how)|recommend where i should go next|where (?:should|do) i (?:go next|start)|what should i do next|what can i do next|what should i click next|what now)\b/i.test(clean);
    const followupIntent = /^(?:and\s+)?(?:tell me more|more details|explain that|what about that|how do i do that|how can i do that|what are the steps|show me the steps|steps please|give me the steps|give me steps|steps)$/.test(clean);
    const stepOnlyIntent = /^(?:what are the steps|show me the steps|steps please|give me the steps|give me steps|steps)$/.test(clean);
    const previousBot = [...(Array.isArray(context.messages) ? context.messages : [])].reverse().find(message => message?.sender_kind === 'bot' && message.body);
    const previousHref = previousBot?.metadata?.page || previousBot?.metadata?.links?.[0]?.href || '';
    let previousPage = String(previousHref).split(/[?#]/)[0].split('/').pop();
    let previousItem = knowledgeByPage.get(previousPage);
    if (!previousItem && previousBot?.metadata?.article_title) previousItem = rankKnowledge(previousBot.metadata.article_title)[0];
    if (followupIntent && !personalIntent && previousItem) {
      const steps = assistantStepsByPage[previousItem.page] || [`Open ${previousItem.title}.`, previousItem.answer, `Use the page actions to continue, or ask SwapBot about a specific control.`];
      const guide = buildKnowledgeGuide(previousItem, relatedKnowledge(previousItem), {
        steps,
        confidence: assistantStepsByPage[previousItem.page] ? .98 : .78,
        followups: followupsFor(previousItem)
      });
      return {...guide, title: `Steps for ${previousItem.title}`};
    }
    if (stepOnlyIntent && !personalIntent) {
      const page = String(context.page || current).split(/[?#]/)[0];
      const item = previousItem || (page === 'index.html' ? null : knowledgeByPage.get(page));
      if (item) return buildKnowledgeGuide(item, relatedKnowledge(item), {
        steps: assistantStepsByPage[item.page] || [`Open ${item.title}.`, item.answer, `Use the page actions to continue, or ask SwapBot about a specific control.`],
        confidence: assistantStepsByPage[item.page] ? .98 : .78,
        followups: followupsFor(item)
      });
      return {
        ...overviewGuide,
        title: 'Start with these steps',
        answer: '1. Open Browse skills and choose a topic you care about.\n2. Add one skill you can teach and one you want to learn to your profile.\n3. Open Skill Matching, review why a person fits, and request one exchange.',
        followups: ['How does matching work?', 'How do I complete my profile?']
      };
    }
    if (guideIntent && !personalIntent) {
      const pageGuide = String(context.page || '').split(/[?#]/)[0] === 'index.html' ? null : currentPageGuide(context.page);
      if (pageGuide) return {
        ...pageGuide,
        title: `Start with ${pageGuide.title}`,
        followups: followupsFor(pageGuide)
      };
      return {
        ...overviewGuide,
        title: 'Your next step',
        links: [
          {title: 'Browse skills', href: 'browse-skills.html', section: 'Explore exchange topics', icon: 'bx-search-alt'},
          {title: 'Skill matching', href: 'skill-matching.html', section: 'Find a suitable partner', icon: 'bx-git-compare'},
          {title: 'Finish your profile', href: 'profile.html', section: 'Improve recommendations', icon: 'bx-user-check'}
        ],
        answer: 'Start with Browse skills to explore options, then open Skill Matching when you are ready to compare people and exchange goals.'
      };
    }
    if (!personalIntent) return base;
    const user = context.user || await getAssistantUser();
    if (!user) return {
      ...base,
      title: 'Sign in for personal help',
      page: 'login.html',
      links: [{title: 'Log in', href: 'login.html', section: 'Account', icon: 'bx-log-in'}, ...(base.links || []).slice(0, 2)],
      confidence: .94,
      answer: `I can answer that from your saved account after you sign in. ${base.answer}`
    };
    const profile = user.profile || {};
    const displayName = profile.display_name || user.username || 'member';
    const credits = Number(user.time_credits || 0).toLocaleString();
    const teach = assistantList(profile.skills_to_teach);
    const learn = assistantList(profile.skills_to_learn);
    const completeness = profileGateCompleteness(user);
    const missing = profileGateMissing(user);
    if (/\b(?:my|account|balance)\b.*\b(?:credit|credits|wallet|balance)\b|\b(?:credit|credits)\b.*\b(?:my|account|balance)\b/i.test(clean)) return {
      ...base,
      title: 'Your credit balance',
      page: 'credits.html',
      links: [{title: 'Open Credit Ledger', href: 'credits.html', section: 'Your account', icon: 'bx-wallet'}, {title: 'Open Calendar', href: 'calendar.html', section: 'Next step', icon: 'bx-calendar'}],
      followups: ['How do I earn credits?', 'How do vouchers work?'],
      confidence: 1,
      answer: `${displayName}, you currently have ${credits} time credit${Number(user.time_credits || 0) === 1 ? '' : 's'}. ${base.answer}`
    };
    if (/\b(?:what do i teach|my teaching|skills i teach|what are my teaching skills)\b/i.test(clean)) return {
      ...base,
      title: 'What you teach',
      page: 'profile.html',
      links: [{title: 'Edit my profile', href: 'profile.html', section: 'Your account', icon: 'bx-user'}],
      confidence: 1,
      answer: teach.length ? `Your profile says you can teach: ${teach.join(', ')}. You can refine these skills in your profile and use them in Skill Matching.` : 'You have not listed a teaching skill yet. Add one in your profile so SwapLabs can explain your teaching fit and recommend better exchanges.'
    };
    if (/\b(?:what am i learning|my learning|skills i want to learn|what do i want to learn)\b/i.test(clean)) return {
      ...base,
      title: 'What you want to learn',
      page: 'profile.html',
      links: [{title: 'Edit my profile', href: 'profile.html', section: 'Your account', icon: 'bx-user'}, {title: 'Find a match', href: 'skill-matching.html', section: 'Next step', icon: 'bx-git-compare'}],
      confidence: 1,
      answer: learn.length ? `Your profile says you want to learn: ${learn.join(', ')}. Open Find a match when you are ready to meet someone who can help.` : 'You have not listed a learning interest yet. Add one in your profile so SwapLabs can find more useful matches.'
    };
    if (/\b(?:what should i do next|recommend where i should go next)\b/i.test(clean)) {
      if (missing.length) return {
        ...base,
        title: 'Your best next step',
        page: 'profile.html',
        links: [{title: 'Finish my profile', href: 'profile.html', section: `${completeness}% complete`, icon: 'bx-user-check'}, {title: 'Open Dashboard', href: 'dashboard.html', section: 'After setup', icon: 'bx-grid-alt'}],
        confidence: 1,
        answer: `Your profile is ${completeness}% complete. Start with ${missing.slice(0, 3).join(', ').toLowerCase()}${missing.length > 3 ? ', then finish the remaining essentials' : ''}. That gives matching enough context to make useful suggestions.`
      };
      return {
        ...base,
        title: 'Your best next step',
        page: 'skill-matching.html',
        links: [{title: 'Find a match', href: 'skill-matching.html', section: 'Recommended next step', icon: 'bx-git-compare'}, {title: 'Browse skills', href: 'browse-skills.html', section: 'Explore first', icon: 'bx-search-alt'}],
        confidence: 1,
        answer: 'Your profile has the essentials. The most useful next step is to open Skill Matching, review the explanation for each suggestion, and request one exchange that fits your goal.'
      };
    }
    if (/\b(?:my profile|my account|profile status|account status)\b/i.test(clean)) return {
      ...base,
      title: 'Your account',
      page: 'profile.html',
      links: [{title: 'Open Profile', href: 'profile.html', section: `${completeness}% complete`, icon: 'bx-user'}, {title: 'Open Dashboard', href: 'dashboard.html', section: `${credits} credits`, icon: 'bx-grid-alt'}],
      confidence: 1,
      answer: `You are signed in as ${displayName}. Your profile is ${completeness}% complete and your current balance is ${credits} time credits.${missing.length ? ` Still to add: ${missing.join(', ').toLowerCase()}.` : ' Your essentials are complete.'}`
    };
    return base;
  };
  window.SwaplabsAssistant.contextualLookup = contextualLookup;
  const navSearch = document.getElementById('navSiteSearch');
  const navSearchInput = document.getElementById('navSiteSearchInput');
  const navSearchResults = document.getElementById('navSearchResults');
  const closeNavSearch = () => {
    if (navSearchResults) {
      navSearchResults.hidden = true;
      navSearchResults.innerHTML = '';
    }
    navSearchInput?.setAttribute('aria-expanded', 'false');
  };
  const renderNavSearch = () => {
    if (!navSearchInput || !navSearchResults) return;
    const query = navSearchInput.value.trim();
    const results = searchSite(query);
    if (query) ensureFullSearchIndex();
    navSearchInput.setAttribute('aria-expanded', String(Boolean(query)));
    if (!query) {
      closeNavSearch();
      return;
    }
    navSearchResults.hidden = false;
    const meta = fullSearchIndexReady ? `${results.length} matches across pages and sections` : 'Searching all pages and sections…';
    navSearchResults.innerHTML = `<div class="nav-search-meta" role="presentation">${escapeText(meta)}</div>` + (results.length ? results.map(result => {
      const context = [result.section, result.kind === 'action' ? 'Action' : ''].filter(Boolean).join(' · ');
      return `<a href="${escapeText(result.page)}" role="option"><i class="bx ${iconMap[result.title]||'bx-right-arrow-alt'}" aria-hidden="true"></i><span><strong>${escapeText(result.title)}</strong><small>${escapeText(context ? `${context} — ${result.answer}` : result.answer)}</small></span></a>`;
    }).join('') :
      '<div class="nav-search-empty"><i class="bx bx-search"></i><span><strong>No matching page or section yet</strong><small>Try feedback, login, safety, workshops, credits, or roadmap.</small></span></div>');
  };
  navSearchInput?.addEventListener('input', renderNavSearch);
  navSearchInput?.addEventListener('focus', renderNavSearch);
  navSearch?.addEventListener('submit', async event => {
    event.preventDefault();
    const query = navSearchInput?.value || '';
    if (!query.trim()) return;
    await ensureFullSearchIndex();
    const topResult = searchSite(query)[0];
    if (topResult) location.href = topResult.page;
  });
  navSearchResults?.addEventListener('click', event => {
    if (event.target.closest('a')) closeNavSearch();
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#navSiteSearch')) closeNavSearch();
  });

  // Keep the Help Center search honest: typing should immediately narrow the
  // visible cards instead of leaving the visitor with an unchanged page.
  const helpSearchInput = document.getElementById('helpSearchInput');
  const helpCards = [...document.querySelectorAll('[data-help-card]')];
  const helpEmpty = document.querySelector('[data-help-empty]');
  const helpSearchStatus = document.getElementById('helpSearchStatus');
  if (helpSearchInput && helpCards.length) {
    helpSearchInput.setAttribute('aria-label', 'Search help articles');
    const updateHelpSearch = () => {
      const query = normalize(helpSearchInput.value);
      const words = query.split(' ').filter(Boolean);
      let visible = 0;
      helpCards.forEach(card => {
        const haystack = normalize(card.textContent || '');
        const matches = !words.length || words.every(word => haystack.includes(word));
        card.hidden = !matches;
        if (matches) visible += 1;
      });
      if (helpEmpty) helpEmpty.hidden = visible > 0;
      if (helpSearchStatus) {
        helpSearchStatus.textContent = query ?
          (visible ? `${visible} help option${visible === 1 ? '' : 's'} found.` : 'No help options found. Try a shorter word or contact support.') :
          'Quick answers are ready below.';
      }
    };
    helpSearchInput.addEventListener('input', updateHelpSearch);
    updateHelpSearch();
  }

  // Notifications has a full-page assistant conversation of its own. Every
  // other page keeps the compact launcher available, including the homepage
  // and onboarding pages where people may need help before they sign in.
  const botHiddenPages = new Set(['notifications.html']);
  if (!botHiddenPages.has(current)) {
    document.body.insertAdjacentHTML('beforeend',
      `<button class="swapbot-launch" id="chatLaunch" aria-label="Open SwapBot" title="Open SwapBot"><span class="swapbot-launch-icon"><i class="bx bx-bot"></i><i class="swapbot-online"></i></span></button><aside class="swapbot-panel" id="chatPanel" aria-label="SwapBot assistant"><div class="swapbot-head"><div class="swapbot-title"><span class="swapbot-avatar"><i class="bx bx-bot"></i></span><div><strong>SwapBot</strong><span><i></i> Website guide and next-step helper</span></div></div><div class="swapbot-head-actions"><button class="swapbot-close" id="chatClose" type="button" aria-label="Close chat" title="Close chat"><i class="bx bx-x"></i></button></div></div><div class="swapbot-messages" id="chatMessages"><div class="swapbot-message"><span class="swapbot-message-label">SwapBot</span>Ask me about any page, section, button, or next step on SwapLabs.</div></div><div class="swapbot-prompt-area"><div class="swapbot-mode-row" aria-label="Chat shortcuts"><button class="active" type="button" data-chat-prompt="Recommend where I should go next" title="Get a recommended next step"><i class="bx bx-compass"></i>Guide me</button><button type="button" data-chat-prompt="Compare Community and Groups for me" title="Compare two SwapLabs options"><i class="bx bx-columns"></i>Compare</button><button type="button" data-chat-prompt="Give me a quick step-by-step for finding a match" title="Get a short step-by-step guide"><i class="bx bx-list-check"></i>Steps</button></div><div class="swapbot-suggestions" aria-label="Popular questions"><button type="button" data-chat-prompt="How does matching work?" title="Ask about matching"><i class="bx bx-git-compare"></i> Matching</button><button type="button" data-chat-prompt="What courses are available?" title="Ask about courses"><i class="bx bx-book-open"></i> Courses</button><button type="button" data-chat-prompt="How do time credits work?" title="Ask about credits"><i class="bx bx-wallet"></i> Credits</button><button type="button" data-chat-prompt="How do I join groups?" title="Ask about groups"><i class="bx bx-group"></i> Groups</button><button type="button" data-chat-prompt="How do I report unsafe activity?" title="Ask about safety"><i class="bx bx-shield-quarter"></i> Safety</button></div></div><form class="swapbot-form" id="chatForm"><label class="swapbot-input-shell" for="chatInput"><i class="bx bx-search-alt"></i><input id="chatInput" placeholder="Ask a question" autocomplete="off"></label><button type="submit" aria-label="Send"><i class="bx bx-send"></i></button></form><div class="swapbot-foot"><i class="bx bx-shield-quarter"></i> Answers use SwapLabs guidance and your current page</div></aside>`
      );
    const assistantLauncher = document.getElementById('chatLaunch');
    assistantLauncher?.setAttribute('aria-label', 'Open SwapBot');
    if (assistantLauncher) assistantLauncher.title = 'Open SwapBot';
    document.getElementById('chatPanel')?.setAttribute('aria-label', 'SwapBot assistant');
    document.querySelectorAll('#chatPanel .swapbot-message-label, #chatPanel .swapbot-title strong').forEach(node => {
      node.textContent = 'SwapBot';
    });
    const panel = document.getElementById('chatPanel'),
      box = document.getElementById('chatMessages'),
      input = document.getElementById('chatInput');
    let widgetAuth;
    let widgetHistory = [];
    let widgetHistoryReminders = [];
    let widgetHistoryReady = false;
    let widgetSending = false;
    const reminderDateLabel = value => {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? String(value || '') : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(parsed);
    };
    const parseWidgetReminder = text => {
      if (!/\b(?:remind\s+me|remember\s+to|(?:set|create|add)\s+(?:a\s+)?reminder|reminder\s+(?:to|for))\b/i.test(text)) return null;
      const original = String(text || '').trim();
      const now = new Date();
      const relative = original.match(/\bin\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\b/i);
      const dayWord = original.match(/\b(today|tomorrow|tonight)\b/i);
      const timeMatch = original.match(/\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
      let due = new Date(now);
      if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        due = new Date(now.getTime() + amount * (unit.startsWith('minute') ? 60000 : unit.startsWith('hour') ? 3600000 : 86400000));
      } else if (dayWord) {
        if (dayWord[1].toLowerCase() !== 'today') due.setDate(due.getDate() + 1);
        due.setHours(dayWord[1].toLowerCase() === 'tonight' ? 20 : 9, 0, 0, 0);
      } else due = new Date(now.getTime() + 3600000);
      if (timeMatch) {
        let hours = Number(timeMatch[1]);
        const minutes = Number(timeMatch[2] || 0);
        const meridiem = String(timeMatch[3] || '').toLowerCase();
        if (meridiem === 'pm' && hours < 12) hours += 12;
        if (meridiem === 'am' && hours === 12) hours = 0;
        due.setHours(hours, minutes, 0, 0);
        if (due <= now) due.setDate(due.getDate() + 1);
      }
      if (dayWord && dayWord[1].toLowerCase() === 'today' && !timeMatch && due <= now) due.setDate(due.getDate() + 1);
      let task = original
        .replace(/^\s*(?:please\s+)?(?:set|create|add)\s+(?:a\s+)?reminder\s*/i, '')
        .replace(/^\s*(?:please\s+)?(?:remind|remember)\s+(?:me\s+)?(?:to\s+)?/i, '')
        .replace(/^\s*(?:please\s+)?reminder\s*/i, '')
        .replace(/^\s*(?:for|to|me\s+to)\s+/i, '')
        .replace(relative?.[0] || '', '')
        .replace(dayWord?.[0] || '', '')
        .replace(timeMatch?.[0] || '', '')
        .replace(/\s+/g, ' ')
        .replace(/\s+(?:at|on|for)\s*$/i, '')
        .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
        .trim();
      if (!task || /^(?:me|a|the)$/i.test(task)) task = 'check in on your next SwapLabs step';
      return {task, dueAt: due.toISOString()};
    };
    const widgetCalendarRequest = async (path, method, body) => {
      if (!widgetAuth?.csrf_token) throw new Error('Sign in again to update your Calendar.');
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': widgetAuth.csrf_token},
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error?.message || result?.error || 'Calendar could not save that change.');
      return result;
    };
    const handleWidgetReminder = async text => {
      if (/\b(?:show|list|what are|any)\b.*\breminders?\b|\breminders?\b.*\b(?:show|list|upcoming)\b/i.test(text)) {
        if (!widgetAuth?.authenticated) return {
          title: 'Sign in to view reminders', page: 'login.html', confidence: .98,
          links: [{title: 'Log in', href: 'login.html', section: 'Private account reminders', icon: 'bx-log-in'}],
          answer: 'Your reminders are private to your SwapLabs account. Sign in to view them.'
        };
        const active = widgetHistoryReminders.filter(item => !item.completed && !item.dismissed);
        return {
          title: 'Your reminders', page: 'calendar.html',
          links: [{title: 'Open Calendar', href: 'calendar.html', section: 'Your events', icon: 'bx-calendar'}],
          followups: ['Remind me to review my profile tomorrow at 7pm'], confidence: 1,
          answer: active.length ? `You have ${active.length} active reminder${active.length === 1 ? '' : 's'}:\n${active.map((item, index) => `${index + 1}. ${item.task} — ${reminderDateLabel(item.due_at || item.dueAt)}`).join('\n')}` : 'You do not have any active reminders yet. Try: “Remind me to review my profile tomorrow at 7pm.”'
        };
      }
      if (/\b(?:cancel|delete|remove|dismiss)\b.*\breminder\b/i.test(text)) {
        if (!widgetAuth?.authenticated) return {
          title: 'Sign in to update reminders', page: 'login.html', confidence: .98,
          links: [{title: 'Log in', href: 'login.html', section: 'Private account reminders', icon: 'bx-log-in'}],
          answer: 'Your reminders are private to your SwapLabs account. Sign in to cancel one.'
        };
        const active = widgetHistoryReminders.filter(item => !item.completed && !item.dismissed);
        if (!active.length) return {title: 'Reminder center', page: 'calendar.html', answer: 'There are no active reminders to cancel.'};
        const words = normalize(text).split(' ').filter(word => word.length > 3 && !['cancel', 'delete', 'remove', 'dismiss', 'reminder', 'reminders'].includes(word));
        const target = active.find(item => words.some(word => normalize(item.task).includes(word))) || active[0];
        if (target.calendar_event_id) await widgetCalendarRequest(`/api/calendar/events/${encodeURIComponent(target.calendar_event_id)}`, 'PATCH', {status: 'cancelled'});
        target.dismissed = true;
        persistWidgetHistory();
        return {
          title: 'Reminder cancelled', page: 'calendar.html',
          links: [{title: 'Open Calendar', href: 'calendar.html', section: 'Your events', icon: 'bx-calendar'}],
          followups: ['Show my reminders'], confidence: 1,
          answer: `Done — I cancelled “${target.task}”${target.calendar_event_id ? ' in your Calendar' : ''}.`
        };
      }
      const parsed = parseWidgetReminder(text);
      if (!parsed) return null;
      if (!widgetAuth?.authenticated) return {
        title: 'Sign in to save a reminder', page: 'login.html', confidence: .98,
        links: [{title: 'Log in', href: 'login.html', section: 'Required for private reminders', icon: 'bx-log-in'}],
        answer: 'Personal reminders are saved to your SwapLabs Calendar. Sign in first, then ask me to set the reminder again.'
      };
      const due = new Date(parsed.dueAt), eventBody = {
        title: `Reminder: ${parsed.task}`,
        description: 'Saved from the private SwapBot chat.',
        starts_at: due.toISOString(),
        ends_at: new Date(due.getTime() + 30 * 60 * 1000).toISOString(),
        timezone: widgetAuth.user?.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        participant_ids: [], location: '', meeting_url: '', reminders_minutes: [0], recurrence: 'none', recurrence_count: 1, all_day: false
      };
      try {
        const result = await widgetCalendarRequest('/api/calendar/events', 'POST', eventBody);
        const eventId = result.event?.id;
        if (!eventId) throw new Error('Calendar did not return the saved event.');
        const saved = {id: `rem_${Date.now().toString(36)}`, task: parsed.task, due_at: parsed.dueAt, created_at: new Date().toISOString(), completed: false, dismissed: false, calendar_event_id: eventId, calendar_saved_at: new Date().toISOString()};
        widgetHistoryReminders.push(saved);
        persistWidgetHistory();
        return {
          title: 'Reminder saved', page: 'calendar.html', confidence: 1,
          links: [{title: 'Open saved event', href: `calendar.html?event=${encodeURIComponent(eventId)}`, section: reminderDateLabel(parsed.dueAt), icon: 'bx-calendar-plus'}],
          followups: ['Show my reminders', 'How do I schedule a session?'],
          answer: `Done — I added “${parsed.task}” to your Calendar for ${reminderDateLabel(parsed.dueAt)}.`
        };
      } catch (error) {
        return {
          title: 'Calendar save failed', page: 'calendar.html', confidence: 1,
          links: [{title: 'Open Calendar', href: 'calendar.html', section: 'Check your account', icon: 'bx-calendar'}],
          answer: `I could not save that reminder, so it has not been marked as done. ${error.message}`
        };
      }
    };
    const widgetHistoryMessage = (message, senderKind, sender) => ({
      id: `ai_widget_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      conversation_id: 'relayskills-ai-assistant',
      sender_id: sender?.id || (senderKind === 'bot' ? 'relayskills-ai-assistant' : ''),
      sender_kind: senderKind,
      sender: senderKind === 'bot' ? {display_name: 'SwapBot', username: 'relayskills-ai', profile_color: 'purple'} : sender,
      body: String(message || '').trim(),
      metadata: {},
      read_by: sender?.id ? [sender.id] : [],
      created_at: new Date().toISOString()
    });
    const appendWidgetExtras = (element, rawLinks = [], followups = []) => {
      const links = Array.isArray(rawLinks) ? rawLinks : [];
      const grid = document.createElement('div');
      grid.className = 'swapbot-link-grid';
      links.slice(0, 3).forEach(item => {
        const href = String(item?.href || '');
        let destination;
        try {
          destination = new URL(href, location.href);
        } catch (_error) {
          return;
        }
        if (!item?.title && !item?.label || destination.origin !== location.origin || !/^https?:$/.test(destination.protocol)) return;
        const link = document.createElement('a'), icon = document.createElement('i'), body = document.createElement('span'), title = document.createElement('strong'), section = document.createElement('small'), arrow = document.createElement('i');
        link.href = `${destination.pathname.split('/').pop() || 'index.html'}${destination.search}${destination.hash}`;
        icon.className = `bx ${item.icon || 'bx-right-arrow-alt'}`;
        title.textContent = item.title || item.label;
        section.textContent = item.section || 'SwapLabs';
        arrow.className = 'bx bx-chevron-right';
        body.append(title, section);
        link.append(icon, body, arrow);
        grid.appendChild(link);
      });
      if (grid.children.length) element.appendChild(grid);
      const prompts = Array.isArray(followups) ? followups.filter(Boolean).slice(0, 2) : [];
      if (prompts.length) {
        const followupRow = document.createElement('div');
        followupRow.className = 'swapbot-followups';
        const label = document.createElement('span');
        label.textContent = 'Continue exploring';
        followupRow.appendChild(label);
        prompts.forEach(prompt => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = prompt;
          button.addEventListener('click', () => sendChat(prompt));
          followupRow.appendChild(button);
        });
        element.appendChild(followupRow);
      }
    };
    const renderWidgetHistory = () => {
      if (!widgetHistory.length) return;
      const pending = [...box.children].filter(element => element.dataset.widgetPending === 'true');
      box.innerHTML = '';
      widgetHistory.forEach(message => {
        if (!message?.body) return;
        const element = document.createElement('div');
        const bot = message.sender_kind === 'bot';
        element.className = `swapbot-message${bot ? '' : ' user'}`;
        if (bot) {
          const label = document.createElement('span');
          label.className = 'swapbot-message-label';
          label.textContent = 'SwapBot';
          element.appendChild(label);
        }
        element.appendChild(document.createTextNode(message.body));
        if (bot) appendWidgetExtras(element, message.metadata?.links, message.metadata?.followups);
        box.appendChild(element);
      });
      pending.forEach(element => box.appendChild(element));
      box.scrollTop = box.scrollHeight;
    };
    const loadWidgetHistory = async () => {
      try {
        widgetAuth = await (window.SwapLabsAuth?.get?.() || fetch('/api/auth/me', {credentials: 'same-origin', cache: 'no-store', mode: 'same-origin'}).then(response => response.ok ? response.json() : null));
        if (!widgetAuth?.authenticated) return;
        const response = await fetch('/api/swapbot/history', {credentials: 'same-origin', cache: 'no-store', mode: 'same-origin'});
        const result = await response.json().catch(() => null);
        if (response.ok && result?.exists && Array.isArray(result.messages)) {
          widgetHistory = result.messages;
          widgetHistoryReminders = Array.isArray(result.reminders) ? result.reminders : [];
          renderWidgetHistory();
        }
      } catch (_error) {
        // The compact assistant can still answer from the local guide offline.
      } finally {
        widgetHistoryReady = true;
      }
    };
    const widgetHistoryLoad = loadWidgetHistory();
    const persistWidgetHistory = () => {
      if (!widgetHistoryReady || !widgetAuth?.authenticated || !widgetAuth.csrf_token || !widgetHistory.length) return;
      fetch('/api/swapbot/history', {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        mode: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': widgetAuth.csrf_token},
        body: JSON.stringify({messages: widgetHistory, reminders: widgetHistoryReminders})
      }).catch(() => {
        // Keep the rendered answer available if saving is temporarily delayed.
      });
    };
    input?.setAttribute('aria-label', 'Ask a question');
    document.getElementById('chatLaunch').addEventListener('click', () => {
      panel.classList.toggle('open');
      document.getElementById('chatLaunch').classList.toggle('active', panel.classList.contains('open'));
      if (panel.classList.contains('open')) input.focus()
    });
    document.getElementById('chatClose').addEventListener('click', () => {
      panel.classList.remove('open');
      document.getElementById('chatLaunch').classList.remove('active')
    });
    const addUser = text => {
      const msg = document.createElement('div');
      msg.className = 'swapbot-message user';
      msg.dataset.widgetPending = 'true';
      msg.textContent = text;
      box.appendChild(msg);
      box.scrollTop = box.scrollHeight
    };
    const showTyping = () => {
      const waiting = document.createElement('div');
      waiting.className = 'swapbot-message';
      waiting.dataset.widgetPending = 'true';
      waiting.innerHTML = '<div class="swapbot-typing"><span></span><span></span><span></span></div>';
      box.appendChild(waiting);
      box.scrollTop = box.scrollHeight;
      return waiting;
    };
    const renderBot = (result, waiting) => {
      waiting.removeAttribute('data-widget-pending');
      waiting.replaceChildren();
      const label = document.createElement('span');
      label.className = 'swapbot-message-label';
      label.textContent = 'SwapBot';
      waiting.append(label, document.createTextNode(String(result.answer || 'I could not find a useful answer for that yet.')));
      const links = Array.isArray(result.links) && result.links.length ? result.links : result.page ? [{title: result.title || 'SwapLabs guide', href: result.page, section: 'Guide'}] : [];
      appendWidgetExtras(waiting, links, result.followups);
      box.scrollTop = box.scrollHeight;
    };
    const setWidgetBusy = busy => {
      widgetSending = busy;
      panel.setAttribute('aria-busy', String(busy));
      input.disabled = busy;
      panel.querySelectorAll('[data-chat-prompt], .swapbot-followups button, .swapbot-form button[type="submit"]').forEach(button => { button.disabled = busy; });
    };
    const sendChat = async text => {
      text = String(text || '').trim();
      if (!text || widgetSending) return;
      setWidgetBusy(true);
      addUser(text);
      input.value = '';
      const waiting = showTyping();
      const indexPromise = ensureFullSearchIndex();
      try {
        await widgetHistoryLoad;
        widgetHistory.push(widgetHistoryMessage(text, 'member', widgetAuth?.user));
        let reply = await handleWidgetReminder(text);
        if (!reply) {
          await indexPromise;
          reply = await window.SwaplabsAssistant.contextualLookup(text, {page: current, user: widgetAuth?.user, messages: widgetHistory});
        }
        const answer = widgetHistoryMessage(reply.answer, 'bot');
        answer.metadata = {
          article_title: reply.title || 'SwapBot answer',
          page: reply.page || '',
          confidence: reply.confidence,
          links: (Array.isArray(reply.links) ? reply.links : []).slice(0, 6).map(link => ({href: link.href, label: link.title || link.label, section: link.section, icon: link.icon})),
          followups: Array.isArray(reply.followups) ? reply.followups.slice(0, 6) : []
        };
        widgetHistory.push(answer);
        if (widgetAuth?.authenticated) persistWidgetHistory();
        renderBot(reply, waiting);
      } catch (_error) {
        renderBot({
          title: 'Local guide temporarily unavailable',
          page: 'help-center.html',
          answer: 'I hit a local issue while reading the site guide. Open the Help Center or try your question again in a moment.',
          links: [{title: 'Help Center', href: 'help-center.html', section: 'Browse support topics'}]
        }, waiting);
      } finally {
        setWidgetBusy(false);
      }
    };
    document.getElementById('chatForm').addEventListener('submit', e => {
      e.preventDefault();
      sendChat(input.value)
    });
    document.querySelectorAll('[data-chat-prompt]').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('[data-chat-prompt]').forEach(item => item.classList.toggle('active', item === button));
      sendChat(button.dataset.chatPrompt);
    }));
  }

  document.getElementById('matchForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const values = new FormData(e.currentTarget);
    sessionStorage.setItem('swaplabs-match-seed', JSON.stringify({
      teach_skills: values.get('teach_skills'),
      learn_skills: values.get('learn_skills'),
      session_format: values.get('session_format')
    }));
    document.getElementById('matchResult')?.classList.add('show');
    setTimeout(() => {
      location.href = 'skill-matching.html'
    }, 260)
  });
  document.querySelectorAll('.faq-q').forEach(q => q.addEventListener('click', () => q.parentElement.classList.toggle(
    'open')));
  document.querySelectorAll('[data-demo-form]').forEach(form => form.addEventListener('submit', e => {
    e.preventDefault();
    form.querySelector('.form-status')?.classList.add('show');
    if (!form.classList.contains('footer-newsletter')) form.reset()
  }));
  const staticActionStoreKey = 'swaplabs-static-actions';
  const readStaticActions = () => {
    try { return JSON.parse(localStorage.getItem(staticActionStoreKey) || '{}') } catch (_error) { return {} }
  };
  const writeStaticActions = values => localStorage.setItem(staticActionStoreKey, JSON.stringify(values));
  const staticActionId = (button, index) => {
    const card = button.closest('article, .card, .event-card, .resource-row, .path-card');
    const heading = card?.querySelector('h2,h3,strong')?.textContent?.trim() || `item-${index}`;
    return `${current}:${heading}:${button.dataset.rsvp !== undefined ? 'rsvp' : button.textContent.trim().toLowerCase()}`;
  };
  const showStaticActionToast = message => {
    let toast = document.querySelector('.platform-toast.static-action-toast');
    if (!toast) { toast = document.createElement('div'); toast.className = 'platform-toast static-action-toast'; document.body.appendChild(toast) }
    toast.innerHTML = `<i class="bx bx-check-circle"></i><span>${message}</span>`;
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(toast.hideTimer); toast.hideTimer = setTimeout(() => toast.classList.remove('show'), 2800)
  };
  document.querySelectorAll('[data-rsvp]').forEach((btn, index) => {
    const id = staticActionId(btn, index), saved = readStaticActions();
    const render = going => { btn.dataset.going = String(going); btn.innerHTML = going ? '<i class="bx bx-check"></i> Going' : 'RSVP'; btn.setAttribute('aria-pressed', String(going)) };
    render(Boolean(saved[id]));
    btn.addEventListener('click', () => {
      const values = readStaticActions(), going = btn.dataset.going !== 'true';
      if (going) values[id] = true; else delete values[id];
      writeStaticActions(values); render(going); showStaticActionToast(going ? 'RSVP saved on this device.' : 'RSVP removed.')
    })
  });
  document.querySelectorAll('[data-action]').forEach((btn, index) => {
    const original = btn.textContent.trim(), label = original.toLowerCase(), id = staticActionId(btn, index);
    if (label.includes('schedule')) {
      btn.addEventListener('click', () => { location.href = 'calendar.html' });
      return
    }
    const completedLabel = label.includes('join') ? 'Joined' : label.includes('enroll') ? 'Enrolled' : label.includes('apply') ? 'Applied' : label.includes('new topic') ? 'Draft saved' : 'Saved';
    const render = active => {
      btn.dataset.active = String(active); btn.setAttribute('aria-pressed', String(active));
      btn.innerHTML = active ? `<i class="bx bx-check"></i> ${completedLabel}` : original
    };
    render(Boolean(readStaticActions()[id]));
    btn.addEventListener('click', () => {
      const values = readStaticActions(), active = btn.dataset.active !== 'true';
      if (active) values[id] = true; else delete values[id];
      writeStaticActions(values); render(active);
      showStaticActionToast(active ? `${completedLabel}. Your choice will still be here when you return.` : 'Removed from your saved choices.')
    })
  });
  document.querySelectorAll('[data-price-toggle]').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-price-toggle]').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    const annual = btn.dataset.priceToggle === 'annual';
    document.querySelectorAll('[data-monthly]').forEach(x => x.textContent = annual ? x.dataset.annual : x
      .dataset.monthly)
  }));
  document.querySelectorAll('[data-choice]').forEach(choice => choice.addEventListener('click', () => {
    choice.parentElement.querySelectorAll('[data-choice]').forEach(x => x.classList.remove('selected'));
    choice.classList.add('selected')
  }));

  const skillSearch = document.getElementById('skillSearch'),
    skillCategory = document.getElementById('skillCategory');
  const filterSkills = () => {
    const term = normalize(skillSearch?.value || ''),
      cat = skillCategory?.value || 'all';
    let visible = 0;
    document.querySelectorAll('.skill-card').forEach(card => {
      const show = normalize(card.textContent).includes(term) && (cat === 'all' || card.dataset.category ===
        cat);
      card.style.display = show ? 'flex' : 'none';
      if (show) visible++
    });
    document.getElementById('skillEmpty')?.classList.toggle('show', !visible)
  };
  skillSearch?.addEventListener('input', filterSkills);
  skillCategory?.addEventListener('change', filterSkills);
  document.getElementById('skillReset')?.addEventListener('click', () => {
    skillSearch.value = '';
    skillCategory.value = 'all';
    filterSkills()
  });

  const liveSkillTarget = document.querySelector('[data-live-skill-typewriter]');
  if (liveSkillTarget) {
    const fallbackSkillPhrases = ['Be the first to list a skill'];
    let skillPhrases = fallbackSkillPhrases;
    let skillPhraseIndex = 0;
    let skillCharacterIndex = 0;
    let deletingSkill = false;
    let skillTypewriterStarted = false;
    const reducedSkillMotion = document.documentElement.classList.contains('pref-reduced-motion');

    const updateSkillPhrases = values => {
      const next = [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim())
        .filter(Boolean))];
      const phrases = next.length ? next : fallbackSkillPhrases;
      if (phrases.join('\u0000') === skillPhrases.join('\u0000')) return;
      skillPhrases = phrases;
      skillPhraseIndex = 0;
      skillCharacterIndex = 0;
      deletingSkill = false;
      if (reducedSkillMotion) liveSkillTarget.textContent = skillPhrases[0]
    };

    const typeLiveSkill = () => {
      const phrase = skillPhrases[skillPhraseIndex] || 'skills from members';
      liveSkillTarget.textContent = deletingSkill ?
        phrase.slice(0, Math.max(0, skillCharacterIndex--)) :
        phrase.slice(0, skillCharacterIndex++);
      let delay = deletingSkill ? 34 : 64;
      if (!deletingSkill && skillCharacterIndex > phrase.length) {
        deletingSkill = true;
        delay = 1650
      } else if (deletingSkill && skillCharacterIndex < 0) {
        deletingSkill = false;
        skillPhraseIndex = (skillPhraseIndex + 1) % skillPhrases.length;
        skillCharacterIndex = 0;
        delay = 320
      }
      setTimeout(typeLiveSkill, delay)
    };

    window.addEventListener('swaplabs:metrics-updated', event => {
      updateSkillPhrases(event.detail?.skill_names);
      if (!reducedSkillMotion && !skillTypewriterStarted) {
        skillTypewriterStarted = true;
        typeLiveSkill()
      }
    });
    updateSkillPhrases(window.SwapLabsSkillNames);
    if (reducedSkillMotion) {
      liveSkillTarget.textContent = skillPhrases[0]
    } else if (!skillTypewriterStarted) {
      skillTypewriterStarted = true;
      typeLiveSkill()
    }
  }

  const typeTarget = document.querySelector('.hero .gradient-text');
  if (typeTarget && !typeTarget.hasAttribute('data-static-motto')) {
    const phrases = ['Inspires You', 'Excites You', 'You Are Passionate About', 'Sparks Your Curiosity', 'Drives You',
      'You Enjoy', 'Fascinates You'
    ];
    typeTarget.innerHTML =
      '<span class="typewriter-static">Learn What</span> <span data-typewriter></span><span class="typewriter-cursor" aria-hidden="true"></span>';
    const output = typeTarget.querySelector('[data-typewriter]');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains(
        'pref-reduced-motion')) {
      output.textContent = phrases[0]
    } else {
      let phraseIndex = 0,
        charIndex = 0,
        deleting = false;
      const type = () => {
        const phrase = phrases[phraseIndex];
        output.textContent = deleting ? phrase.slice(0, charIndex--) : phrase.slice(0, charIndex++);
        let delay = deleting ? 34 : 62;
        if (!deleting && charIndex > phrase.length) {
          deleting = true;
          delay = 1500
        } else if (deleting && charIndex < 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % phrases.length;
          charIndex = 0;
          delay = 280
        }
        setTimeout(type, delay)
      };
      type();
    }
  }

  const isUtilityPage = pages.account.some(([, href]) => href === current) || ['member-profile.html', 'workshops.html',
    'contact.html', 'complaint.html', 'feedback.html', 'skill-innovation.html', 'calendar.html', 'credits.html',
    'marketplace.html', 'gifts.html', 'student-safety.html', 'mentor-dashboard.html', 'skill-battle.html', 'funding-hub.html',
    'moderation-center.html', 'roadmap.html', 'site-credits.html', 'community.html', 'blog.html'
  ].includes(current);
  if (!isUtilityPage) {
    const contentScript = document.createElement('script');
    contentScript.src = 'scripts/swaplabs-content.js?v=20261002-metrics-all-interactions1';

    document.body.appendChild(contentScript);
  }
  // Chats is a full-screen private workspace. Do not load the public metrics
  // injector there; it adds the home-page directory/footer while the inbox is
  // still initializing and makes a slow session look like the wrong page.
  const needsLiveData = Boolean(document.querySelector('[data-live-feed], [data-skill-search], [data-skill-rotator]'));
  if (needsLiveData && current !== 'notifications.html') {
    const liveDataScript = document.createElement('script');
    liveDataScript.src = 'scripts/swaplabs-live-data.js?v=20260929-conversations4';
    document.body.appendChild(liveDataScript);
  }
  const loadWhenIdle = (callback, timeout = 1200) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(callback, {timeout});
    } else {
      window.setTimeout(callback, Math.min(timeout, 900));
    }
  };
  const loadOperations = () => {
    if (document.querySelector('script[data-swaplabs-operations], script[src*="swaplabs-operations.js"]')) return;
    const operationsScript = document.createElement('script');
    operationsScript.dataset.swaplabsOperations = 'true';
    operationsScript.src = 'scripts/swaplabs-operations.js?v=20261002-chat-readfast3';
    document.body.appendChild(operationsScript);
  };
  const loadAuth = () => {
    if (document.querySelector('script[data-swaplabs-auth]')) return;
    const authScript = document.createElement('script');
    authScript.dataset.swaplabsAuth = 'true';
    authScript.src = 'scripts/swaplabs-auth.js?v=20261005-presence3';
    document.body.appendChild(authScript);
  };
  if (!document.querySelector('link[data-streak-styles]')) {
    const streakStyles = document.createElement('link');
    streakStyles.rel = 'stylesheet';
    streakStyles.href = 'styles/streaks.css?v=20260930-navbar-icons3';
    streakStyles.dataset.streakStyles = 'true';
    document.head.appendChild(streakStyles);
  }
  const loadCalls = () => {
    if (!document.querySelector('link[data-direct-call-styles]')) {
      const callStyles = document.createElement('link');
      callStyles.rel = 'stylesheet';
      callStyles.href = 'styles/direct-calls.css?v=20260930-direct-calls1';
      callStyles.dataset.directCallStyles = 'true';
      document.head.appendChild(callStyles);
      ensureVisibilityStyles();
    }
    if (document.querySelector('script[data-swaplabs-calls], script[src*="swaplabs-calls.js"]')) return;
    const callsScript = document.createElement('script');
    callsScript.dataset.swaplabsCalls = 'true';
    callsScript.src = 'scripts/swaplabs-calls.js?v=20261002-perf1';
    document.body.appendChild(callsScript);
  };
  // Profile and admin pages include the options registry synchronously so
  // country selectors are populated before a user can open the native menu.
  // Keep the dynamic fallback for older/utility pages, but never load a
  // second copy because it can reset a selection while the form is active.
  const needsOptions = Boolean(document.querySelector('[data-country-select], [data-country-timezone-select], [data-option-list], [data-multi-options], [data-skill-picker-ui], [data-age-select]'));
  if (needsOptions && !window.SwapLabsOptions && !document.querySelector('script[data-swaplabs-options]')) {
    const optionsScript = document.createElement('script');
    optionsScript.dataset.swaplabsOptions = 'true';
    optionsScript.src = 'scripts/swaplabs-options.js?v=20261003-skill-search-order1';
    document.body.appendChild(optionsScript);
  }
  // Feature bundles are loaded only where their markup exists. The old
  // behavior downloaded large no-op files on every route, including the
  // public homepages.
  const needsOperations = Boolean(document.querySelector('[data-operations-page], [data-auth-page="admin"]'));
  if (needsOperations) loadOperations();

  const needsPlatform = Boolean(document.querySelector('[data-platform-page], #testimonialBeltTrack, #feedbackCommunityGrid, [data-auth-page="admin"]'));
  if (needsPlatform) {
    const platformScript = document.createElement('script');
    platformScript.src = 'scripts/swaplabs-platform.js?v=20261002-perf1';
    document.body.appendChild(platformScript);
  }

  // Account forms and protected workspaces need auth immediately. Public
  // pages still get the same live navigation and session behavior, but their
  // large auth bundle waits until the browser has rendered the first view.
  const authIsCritical = Boolean(document.querySelector('[data-auth-page], [data-operations-page]')) ||
    ['notifications.html', 'dashboard.html', 'skill-matching.html', 'video-room.html', 'session-room.html', 'study-together.html'].includes(current);
  if (authIsCritical) loadAuth();
  else loadWhenIdle(loadAuth, 1500);

  // Incoming calls remain available across the site, but the polling shell is
  // non-critical for the first paint. Room pages load it immediately.
  const callIsCritical = ['video-room.html', 'session-room.html', 'study-together.html'].includes(current) ||
    Boolean(document.querySelector('[data-video-room], [data-call-room]'));
  if (callIsCritical) loadCalls();
  else loadWhenIdle(loadCalls, 2200);

  // Keep the visibility contract after every synchronous and deferred style
  // bundle. This is deliberately the last shared stylesheet in the cascade.
  function ensureVisibilityStyles() {
    let visibilityStyles = document.querySelector('link[data-visibility-contrast]');
    if (!visibilityStyles) {
      visibilityStyles = document.createElement('link');
      visibilityStyles.rel = 'stylesheet';
      visibilityStyles.href = 'styles/visibility-contrast.css?v=20261006-dark-contrast3';
      visibilityStyles.dataset.visibilityContrast = 'true';
    }
    document.head.appendChild(visibilityStyles);
  }
  ensureVisibilityStyles();

  // Keep the dark-mode readability contract after the visibility bundle too.
  // That bundle is intentionally the last shared stylesheet, so re-append
  // the contrast link after it to prevent older muted dashboard rules from
  // winning the cascade.
  function ensureDarkModeContrastStyles() {
    let contrastStyles = document.querySelector('link[data-relay-dark-mode-contrast]');
    if (!contrastStyles) {
      contrastStyles = document.createElement('link');
      contrastStyles.rel = 'stylesheet';
      contrastStyles.href = window.location.origin + '/styles/dark-mode-contrast.css?v=20261010-gradient-text1';
      contrastStyles.dataset.relayDarkModeContrast = 'true';
    }
    document.head.appendChild(contrastStyles);
  }
  ensureDarkModeContrastStyles();
})();
