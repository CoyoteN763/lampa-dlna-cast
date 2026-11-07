(function () {
'use strict';
if (window.__dlna_cast_loaded) return;
window.__dlna_cast_loaded = true;

var PLUGIN_ID = 'dlna_cast';
var PLUGIN_VERSION = '3.1.0';
var STORAGE_KEYS = {
  DEVICES: 'dlna_cast_devices',
  SELECTED_DEVICE: 'dlna_cast_selected_device',
  MANUAL_IP: 'dlna_cast_manual_ip',
  HOST_IP: 'dlna_cast_host_ip',
  ASK_ALWAYS: 'dlna_cast_ask_always',
  PROXY_PORT: 'dlna_cast_proxy_port',
  BRIDGE_URL: 'dlna_cast_bridge_url',
  AUTO_RECONNECT: 'dlna_cast_auto_reconnect',
  ENABLE_WIDGET: 'dlna_cast_enable_widget',
  SOAP_TIMEOUT: 'dlna_cast_soap_timeout',
  RETRY_COUNT: 'dlna_cast_retry_count',
  ENABLE_PROXY: 'dlna_cast_enable_proxy',
  PROXY_REFERER: 'dlna_cast_proxy_referer',
  PROXY_USER_AGENT: 'dlna_cast_proxy_user_agent',
  PROXY_COOKIE: 'dlna_cast_proxy_cookie',
  PROXY_AUTHORIZATION: 'dlna_cast_proxy_authorization'
};

var DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8099';
var DEFAULT_PROXY_PORT = 8099;
var DEFAULT_SOAP_TIMEOUT = 5000;
var DEFAULT_RETRY_COUNT = 3;

// Известные эндпоинты AVTransport у популярных ТВ (для клиентского фоллбэка и бриджа)
var COMMON_AV_PATHS = [
  '/upnp/control/rendertransport1',       // Samsung
  '/dmr/upnp/control/AVTransport1',       // LG
  '/MediaRenderer/AVTransport/Control',   // Sony/Philips (DLNA)
  '/AVTransport/control',
  '/upnp/control/AVTransport1',
  '/avtransport/control',
  '/UDNA/AVTransport/control'
];
var COMMON_RC_PATHS = [
  '/upnp/control/rendercontrol1',         // Samsung
  '/dmr/upnp/control/RenderingControl1',  // LG
  '/MediaRenderer/RenderingControl/Control',
  '/RenderingControl/control'
];

function log() {
  try {
    if (window.lampa_log || window.localStorage.getItem('lampa_log') === 'true') {
      console.log('[DLNA Cast]', Array.prototype.slice.call(arguments).join(' '));
    }
  } catch (e) {}
}

function noty(message, type) {
  type = type || 'info';
  try {
    if (window.Lampa && Lampa.Noty && typeof Lampa.Noty.show === 'function') {
      Lampa.Noty.show(message, { type: type, timeout: 4000 });
      return;
    }
  } catch (e) {}
  console.log('[DLNA Cast Noty]', '[' + type + ']', message);
}

function addLang() {
  try {
    Lampa.Lang.add({
      dlna_cast_title: { ru: 'DLNA Трансляция', en: 'DLNA Cast' },
      dlna_cast_scan: { ru: 'Сканировать сеть', en: 'Scan network' },
      dlna_cast_device: { ru: 'DLNA-устройство', en: 'DLNA device' },
      dlna_cast_manual_ip: { ru: 'Ручной IP телевизора', en: 'Manual TV IP' },
      dlna_cast_add_manual: { ru: 'Добавить устройство по IP', en: 'Add device by IP' },
      dlna_cast_bridge: { ru: 'Адрес бриджа', en: 'Bridge URL' },
      dlna_cast_host_ip: { ru: 'IP хоста Lampa', en: 'Lampa host IP' },
      dlna_cast_ask: { ru: 'Всегда спрашивать', en: 'Always ask' },
      dlna_cast_auto_reconnect: { ru: 'Автопереподключение', en: 'Auto reconnect' },
      dlna_cast_widget: { ru: 'Кнопка в плеере', en: 'Player widget' },
      dlna_cast_timeout: { ru: 'Таймаут SOAP (мс)', en: 'SOAP timeout (ms)' },
      dlna_cast_retry: { ru: 'Попытки при ошибке', en: 'Retry count' }
    });
  } catch (e) { log('Lang.add ошибка', e); }
}

function t(key) {
  try { return Lampa.Lang.translate(key); } catch (e) { return key; }
}

// =========================================================================
// BRIDGE CLIENT — связь с локальным бриджем (SSDP + SOAP-прокси)
// =========================================================================
var Bridge = {
  url: function () {
    var u = (Lampa.Storage.get(STORAGE_KEYS.BRIDGE_URL, DEFAULT_BRIDGE_URL) || DEFAULT_BRIDGE_URL).trim();
    return u.replace(/\/$/, '');
  },
  request: function (path, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open(opts.method || 'GET', Bridge.url() + path, true);
        xhr.timeout = opts.timeout || 10000;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText || '{}')); }
            catch (e) { resolve({}); }
          } else reject(new Error('HTTP ' + xhr.status));
        };
        xhr.onerror = function () { reject(new Error('bridge unreachable')); };
        xhr.ontimeout = function () { reject(new Error('bridge timeout')); };
        xhr.send(opts.data ? JSON.stringify(opts.data) : null);
      } catch (e) { reject(e); }
    });
  },
  ping: function () { return Bridge.request('/ping', { timeout: 3000 }); },
  scan: function () { return Bridge.request('/scan?timeout=4', { timeout: 15000 }); },
  detect: function (ip) { return Bridge.request('/detect?ip=' + encodeURIComponent(ip), { timeout: 20000 }); },
  control: function (device, action, body, serviceType) {
    return Bridge.request('/control', {
      method: 'POST', timeout: 15000,
      data: {
        ip: device.ip,
        controlURL: device.controlURL,
        controlHost: device.controlHost, controlPort: device.controlPort, controlScheme: device.controlScheme,
        renderingControlURL: device.renderingControlURL, renderingControlHost: device.renderingControlHost, renderingControlPort: device.renderingControlPort, renderingControlScheme: device.renderingControlScheme,
        serviceType: serviceType || device.serviceType,
        action: action,
        body: body
      }
    }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'SOAP error');
      return r.response || '';
    });
  }
};

// =========================================================================
// DEVICE STORE — список устройств + перестройка select в настройках
// =========================================================================
var DeviceStore = {
  items: {}, // общий объект values для select (передаётся по ссылке в SettingsApi)
  read: function () {
    var d = Lampa.Storage.get(STORAGE_KEYS.DEVICES, []);
    return Array.isArray(d) ? d : [];
  },
  save: function (devices) { Lampa.Storage.set(STORAGE_KEYS.DEVICES, devices); },
  rebuild: function () {
    var savedDevices = this.read();
    var items = {};
    for (var i = 0; i < savedDevices.length; i++) {
      var d = savedDevices[i] || {};
      items[String(i)] = (d.friendlyName || d.ip || ('Устройство ' + (i + 1))) + (d.ip ? ' (' + d.ip + ')' : '');
    }
    if (Object.keys(items).length === 0) items['-1'] = 'Нет устройств';
    var current = String(Lampa.Storage.get(STORAGE_KEYS.SELECTED_DEVICE, '-1'));
    if (!Object.prototype.hasOwnProperty.call(items, current)) {
      if (current === '' || current === '-1') current = '-1';
      else items[current] = 'Устройство №' + current;
    }
    // мутируем общий объект — select в настройках обновится при следующем открытии
    for (var k in this.items) delete this.items[k];
    for (var k2 in items) this.items[k2] = items[k2];
    Lampa.Storage.set(STORAGE_KEYS.SELECTED_DEVICE, current);
    return current;
  },
  upsert: function (device) {
    var devices = this.read();
    var found = -1;
    for (var i = 0; i < devices.length; i++) if (devices[i] && devices[i].ip === device.ip) found = i;
    if (found >= 0) devices[found] = device; else devices.push(device);
    this.save(devices);
    var current = String(found >= 0 ? found : devices.length - 1);
    Lampa.Storage.set(STORAGE_KEYS.SELECTED_DEVICE, current);
    this.rebuild();
    return device;
  }
};

// Определить устройство по IP: сначала через бридж, потом прямым перебором
function detectDevice(ip) {
  ip = (ip || '').trim();
  if (!ip) return Promise.reject(new Error('Пустой IP'));
  return Bridge.detect(ip).then(function (r) {
    if (r.device) return r.device;
    throw new Error('Бридж не нашёл AVTransport на ' + ip);
  }).catch(function (bridgeErr) {
    log('Бридж недоступен (' + bridgeErr.message + '), пробуем прямой перебор');
    return probeDeviceDirect(ip);
  });
}

// Прямой перебор эндпоинтов (скорее всего упадёт по CORS, но попытка бесплатна)
function probeDeviceDirect(ip) {
  var timeout = parseInt(Lampa.Storage.get(STORAGE_KEYS.SOAP_TIMEOUT, DEFAULT_SOAP_TIMEOUT), 10);
  var tryPath = function (idx) {
    if (idx >= COMMON_AV_PATHS.length) return Promise.reject(new Error('Не найден AVTransport на ' + ip + ' (CORS?)'));
    var path = COMMON_AV_PATHS[idx];
    return new Promise(function (resolve, reject) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'http://' + ip + path, true);
        xhr.timeout = timeout;
        xhr.setRequestHeader('Content-Type', 'text/xml; charset="utf-8"');
        xhr.setRequestHeader('SOAPAction', '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"');
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 400) {
            resolve({ ip: ip, friendlyName: 'TV ' + ip, serviceType: 'urn:schemas-upnp-org:service:AVTransport:1', controlURL: path });
          } else reject(new Error('HTTP ' + xhr.status));
        };
        xhr.onerror = function () { reject(new Error('network/CORS')); };
        xhr.ontimeout = function () { reject(new Error('timeout')); };
        var body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo></s:Body></s:Envelope>';
        xhr.send(body);
      } catch (e) { reject(e); }
    }).catch(function () { return tryPath(idx + 1); });
  };
  return tryPath(0);
}

// =========================================================================
// НАСТРОЙКИ
// =========================================================================
function initSettings() {
  if (typeof Lampa === 'undefined' || !Lampa.SettingsApi || typeof Lampa.SettingsApi.addComponent !== 'function') {
    log('SettingsApi недоступен');
    return;
  }
  Lampa.SettingsApi.addComponent({
    component: PLUGIN_ID,
    name: t('dlna_cast_title'),
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/></svg>'
  });

  // Сканирование через бридж
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: 'dlna_scan_btn', type: 'trigger', values: '', placeholder: '', default: false },
    field: { name: t('dlna_cast_scan'), description: 'SSDP M-SEARCH через бридж' },
    onChange: function () {
      var active = Lampa.Storage.get('dlna_scan_btn');
      if (!active) return;
      noty('Сканирование сети...', 'info');
      Bridge.scan().then(function (res) {
        var devices = res.devices || [];
        DeviceStore.save(devices);
        DeviceStore.rebuild();
        Lampa.Storage.set('dlna_scan_btn', false);
        if (devices.length) noty('Найдено устройств: ' + devices.length, 'success');
        else noty('Устройства не найдены. Включен ли ТВ? Бридж в той же сети?', 'warning');
      }).catch(function (err) {
        Lampa.Storage.set('dlna_scan_btn', false);
        noty('Сканирование недоступно: ' + err.message + '. Бридж запущен?', 'error');
      });
    }
  });

  // Ручной IP
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.MANUAL_IP, type: 'input', values: '', placeholder: '192.168.1.50', default: '' },
    field: { name: t('dlna_cast_manual_ip') }
  });

  // Добавить устройство по IP (проверка + добавление в список)
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: 'dlna_add_manual_btn', type: 'trigger', values: '', placeholder: '', default: false },
    field: { name: t('dlna_cast_add_manual'), description: 'Проверить IP выше и добавить в список устройств' },
    onChange: function () {
      var active = Lampa.Storage.get('dlna_add_manual_btn');
      if (!active) return;
      Lampa.Storage.set('dlna_add_manual_btn', false);
      var ip = (Lampa.Storage.get(STORAGE_KEYS.MANUAL_IP, '') || '').trim();
      if (!ip) { noty('Сначала впишите IP телевизора выше', 'warning'); return; }
      noty('Проверка ' + ip + '...', 'info');
      detectDevice(ip).then(function (device) {
        DeviceStore.upsert(device);
        noty('Добавлено: ' + (device.friendlyName || ip), 'success');
      }).catch(function (err) {
        noty('Не удалось подключиться: ' + err.message, 'error');
      });
    }
  });

  // Выбор устройства (deviceItems — общий объект, обновляется после сканирования)
  DeviceStore.rebuild();
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.SELECTED_DEVICE, type: 'select', values: DeviceStore.items, placeholder: '', default: String(Lampa.Storage.get(STORAGE_KEYS.SELECTED_DEVICE, '-1')) },
    field: { name: t('dlna_cast_device') }
  });

  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.BRIDGE_URL, type: 'input', values: '', placeholder: DEFAULT_BRIDGE_URL, default: DEFAULT_BRIDGE_URL },
    field: { name: t('dlna_cast_bridge'), description: 'http://IP_компьютера:8099 — где запущен бридж' }
  });
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.HOST_IP, type: 'input', values: '', placeholder: '', default: '' },
    field: { name: t('dlna_cast_host_ip') }
  });
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.ASK_ALWAYS, type: 'trigger', values: '', placeholder: '', default: true },
    field: { name: t('dlna_cast_ask') }
  });
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.AUTO_RECONNECT, type: 'trigger', values: '', placeholder: '', default: true },
    field: { name: t('dlna_cast_auto_reconnect'), description: 'Автоматически переподключаться к ТВ' }
  });
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.ENABLE_WIDGET, type: 'trigger', values: '', placeholder: '', default: true },
    field: { name: t('dlna_cast_widget'), description: 'Показывать кнопку DLNA в плеере' }
  });
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.SOAP_TIMEOUT, type: 'input', values: '', placeholder: '5000', default: String(DEFAULT_SOAP_TIMEOUT) },
    field: { name: t('dlna_cast_timeout') }
  });
  Lampa.SettingsApi.addParam({
    component: PLUGIN_ID,
    param: { name: STORAGE_KEYS.RETRY_COUNT, type: 'input', values: '', placeholder: '3', default: String(DEFAULT_RETRY_COUNT) },
    field: { name: t('dlna_cast_retry') }
  });
  Lampa.SettingsApi.addParam({ component: PLUGIN_ID, param: { name: STORAGE_KEYS.PROXY_PORT, type: 'input', values: '', placeholder: '8099', default: String(DEFAULT_PROXY_PORT) }, field: { name: 'Порт видеопрокси', description: 'Должен совпадать с портом Python-бbridge (DLNA_BRIDGE_PORT)' } });
  Lampa.SettingsApi.addParam({ component: PLUGIN_ID, param: { name: STORAGE_KEYS.ENABLE_PROXY, type: 'trigger', values: '', default: false }, field: { name: 'Проксировать видеопотоки', description: 'Передавать поток через Python-бbridge; телевизор должен видеть его IP' } });
  Lampa.SettingsApi.addParam({ component: PLUGIN_ID, param: { name: STORAGE_KEYS.PROXY_REFERER, type: 'input', values: '', placeholder: 'https://site.example/', default: '' }, field: { name: 'Referer для прокси' } });
  Lampa.SettingsApi.addParam({ component: PLUGIN_ID, param: { name: STORAGE_KEYS.PROXY_USER_AGENT, type: 'input', values: '', placeholder: 'Mozilla/5.0', default: '' }, field: { name: 'User-Agent для прокси' } });
  Lampa.SettingsApi.addParam({ component: PLUGIN_ID, param: { name: STORAGE_KEYS.PROXY_COOKIE, type: 'input', values: '', placeholder: 'session=...', default: '' }, field: { name: 'Cookie для прокси' } });
  Lampa.SettingsApi.addParam({ component: PLUGIN_ID, param: { name: STORAGE_KEYS.PROXY_AUTHORIZATION, type: 'input', values: '', placeholder: 'Bearer ...', default: '' }, field: { name: 'Authorization для прокси' } });
  log('Настройки зарегистрированы');
}

// =========================================================================
// URL RESOLVER
// =========================================================================
var UrlResolver = {
  resolve: function (url) {
    if (!url) return url;
    var lower = url.toLowerCase();
    var isLocal = lower.includes('127.0.0.1') || lower.includes('localhost');
    var isTorrentStream = lower.includes('/stream') || lower.includes('torrserver') || lower.includes('lampac');
    if (!isLocal && !isTorrentStream) return url;
    var hostIp = this.detectHostIp();
    if (!hostIp) {
      noty('Видео имеет локальный URL. Укажите сетевой IP хоста в настройках.', 'warning');
      return url;
    }
    try {
      var parsed = new URL(url);
      parsed.hostname = hostIp;
      return parsed.toString();
    } catch (e) {
      return url.replace(/127\.0\.0\.1/g, hostIp).replace(/localhost/g, hostIp);
    }
  },
  proxyUrl: function (url) {
    var enabled = Lampa.Storage.get(STORAGE_KEYS.ENABLE_PROXY, false);
    if (!enabled || /\/proxy\?/.test(url)) return url;
    var bridge = Bridge.url();
    var port = parseInt(Lampa.Storage.get(STORAGE_KEYS.PROXY_PORT, DEFAULT_PROXY_PORT), 10) || DEFAULT_PROXY_PORT;
    try { var b = new URL(bridge); if (!b.hostname || b.hostname === '127.0.0.1' || b.hostname === 'localhost') throw new Error('Set LAN bridge IP');
      b.port = String(port); b.pathname = '/proxy'; b.search = '?url=' + encodeURIComponent(url);
      var ref = Lampa.Storage.get(STORAGE_KEYS.PROXY_REFERER, ''); var ua = Lampa.Storage.get(STORAGE_KEYS.PROXY_USER_AGENT, '');
      var cookie = Lampa.Storage.get(STORAGE_KEYS.PROXY_COOKIE, ''); var auth = Lampa.Storage.get(STORAGE_KEYS.PROXY_AUTHORIZATION, '');
      if (ref) b.search += '&referer=' + encodeURIComponent(ref); if (ua) b.search += '&user_agent=' + encodeURIComponent(ua);
      if (cookie) b.search += '&cookie=' + encodeURIComponent(cookie); if (auth) b.search += '&authorization=' + encodeURIComponent(auth);
      return b.toString();
    } catch (e) { noty('Для прокси укажите LAN-адрес Python-бbridge, а не 127.0.0.1', 'warning'); return url; }
  },
  detectHostIp: function () {
    if (window.location.protocol.startsWith('http') && window.location.hostname) {
      var h = window.location.hostname;
      if (h !== 'localhost' && h !== '127.0.0.1') return h;
    }
    var manualHost = Lampa.Storage.get(STORAGE_KEYS.HOST_IP, '');
    if (manualHost) return manualHost;
    return null;
  }
};

// =========================================================================
// DLNA RENDERER (SOAP) — сначала через бридж, при отказе прямой XHR
// =========================================================================
var DLNARenderer = function (device) {
  this.device = device;
  this.ip = device.ip;
  this.controlURL = device.controlURL || '/upnp/control/rendertransport1';
  this.renderingControlURL = device.renderingControlURL || '/upnp/control/rendercontrol1';
  this.serviceType = device.serviceType || 'urn:schemas-upnp-org:service:AVTransport:1';
  this.renderingControlService = 'urn:schemas-upnp-org:service:RenderingControl:1';
  this.proxyPort = parseInt(Lampa.Storage.get(STORAGE_KEYS.PROXY_PORT, DEFAULT_PROXY_PORT), 10);
  this.timeout = parseInt(Lampa.Storage.get(STORAGE_KEYS.SOAP_TIMEOUT, DEFAULT_SOAP_TIMEOUT), 10);
  this.retryCount = parseInt(Lampa.Storage.get(STORAGE_KEYS.RETRY_COUNT, DEFAULT_RETRY_COUNT), 10);
};

DLNARenderer.prototype._escapeXml = function (str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
};

DLNARenderer.prototype._buildMetadata = function (url, title, mimeHint) {
  var mime = 'video/mp4';
  var lower = String(mimeHint || url).toLowerCase();
  if (lower.includes('.m3u8')) mime = 'application/vnd.apple.mpegurl';
  else if (lower.includes('.mkv')) mime = 'video/x-matroska';
  else if (lower.includes('.ts')) mime = 'video/mp2t';
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    '<dc:title>' + this._escapeXml(title) + '</dc:title>' +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    '<res protocolInfo="http-get:*:' + mime + ':*">' + this._escapeXml(url) + '</res>' +
    '</item></DIDL-Lite>';
};

DLNARenderer.prototype._sendSoap = function (action, bodyXml, serviceType, retryNum) {
  var self = this;
  if (typeof retryNum === 'undefined') retryNum = 0;
  serviceType = serviceType || this.serviceType;
  var doRequest = function () {
    // Приоритет: бридж (обходит CORS). При отказе — прямой XHR.
    return Bridge.control(self.device, action, bodyXml, serviceType).catch(function (bridgeErr) {
      log('Бридж не ответил (' + bridgeErr.message + '), прямой запрос к ТВ');
      return self._sendSoapDirect(action, bodyXml, serviceType);
    });
  };
  return doRequest().catch(function (err) {
    log('SOAP ошибка:', action, err.message || err);
    if (retryNum < self.retryCount) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          self._sendSoap(action, bodyXml, serviceType, retryNum + 1).then(resolve, reject);
        }, 1000);
      });
    }
    throw err;
  });
};

DLNARenderer.prototype._sendSoapDirect = function (action, bodyXml, serviceType) {
  var self = this;
  var soapAction = '"' + serviceType + '#' + action + '"';
  var envelope = '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:' + action + ' xmlns:u="' + serviceType + '">' + bodyXml + '</u:' + action + '></s:Body></s:Envelope>';
  var targetUrl = 'http://' + this.ip + (serviceType === this.renderingControlService ? this.renderingControlURL : this.controlURL);
  return new Promise(function (resolve, reject) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', targetUrl, true);
      xhr.timeout = self.timeout;
      xhr.setRequestHeader('Content-Type', 'text/xml; charset="utf-8"');
      xhr.setRequestHeader('SOAPAction', soapAction);
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 400) resolve(xhr.responseText);
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () { reject(new Error('Network/CORS error')); };
      xhr.ontimeout = function () { reject(new Error('Timeout')); };
      xhr.send(envelope);
    } catch (e) { reject(e); }
  });
};

DLNARenderer.prototype.play = function (videoUrl, title) {
  var self = this;
  title = title || 'Lampa Stream';
  var sourceUrl = UrlResolver.resolve(videoUrl);
  var resolvedUrl = UrlResolver.proxyUrl(sourceUrl);
  if (!resolvedUrl || resolvedUrl.includes('127.0.0.1') || resolvedUrl.includes('localhost')) {
    noty('URL видео не является сетевым.', 'error');
    return Promise.reject(new Error('Non-network URL'));
  }
  var metadata = this._buildMetadata(resolvedUrl, title, sourceUrl);
  var setUriBody = '<InstanceID>0</InstanceID>' +
    '<CurrentURI>' + this._escapeXml(resolvedUrl) + '</CurrentURI>' +
    '<CurrentURIMetaData>' + this._escapeXml(metadata) + '</CurrentURIMetaData>';
  return this._sendSoap('SetAVTransportURI', setUriBody).then(function () {
    return self._sendSoap('Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
  }).then(function () {
    noty('Трансляция запущена на телевизоре.', 'success');
    var previous = window.dlna_cast_status || {};
    window.dlna_cast_status = { playing: true, paused: false, url: resolvedUrl, title: title, device: self.device, updated: Date.now(), reconnects: previous.reconnects || 0 };
    return true;
  });
};

DLNARenderer.prototype.stop = function () {
  return this._sendSoap('Stop', '<InstanceID>0</InstanceID>').then(function () {
    noty('Трансляция остановлена.', 'info');
    window.dlna_cast_status = { playing: false };
    return true;
  });
};

DLNARenderer.prototype.pause = function () {
  return this._sendSoap('Pause', '<InstanceID>0</InstanceID>').then(function () {
    if (window.dlna_cast_status) { window.dlna_cast_status.playing = false; window.dlna_cast_status.paused = true; }
    return true;
  });
};

DLNARenderer.prototype.resume = function () {
  return this._sendSoap('Play', '<InstanceID>0</InstanceID><Speed>1</Speed>').then(function () {
    if (window.dlna_cast_status) { window.dlna_cast_status.playing = true; window.dlna_cast_status.paused = false; }
    return true;
  });
};

DLNARenderer.prototype.seek = function (seconds) {
  seconds = parseInt(seconds, 10) || 0;
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var timeStr = (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  return this._sendSoap('Seek', '<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>' + timeStr + '</Target>').then(function () {
    log('Перемотка на:', timeStr);
    return true;
  });
};

DLNARenderer.prototype.setVolume = function (volume) {
  return this._sendSoap('SetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>' + volume + '</DesiredVolume>', this.renderingControlService).then(function () { return true; });
};

DLNARenderer.prototype.getVolume = function () {
  return this._sendSoap('GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>', this.renderingControlService).then(function (response) {
    var match = String(response).match(/<CurrentVolume>(\d+)<\/CurrentVolume>/);
    return match ? parseInt(match[1], 10) : 0;
  });
};

DLNARenderer.prototype.getStatus = function () {
  return this._sendSoap('GetTransportInfo', '<InstanceID>0</InstanceID>').then(function (response) {
    var match = String(response).match(/<CurrentTransportState>(\w+)<\/CurrentTransportState>/);
    return match ? match[1] : 'UNKNOWN';
  });
};

DLNARenderer.prototype.getPosition = function () {
  return this._sendSoap('GetPositionInfo', '<InstanceID>0</InstanceID>').then(function (response) {
    var match = String(response).match(/<RelTime>([^<]+)<\/RelTime>/);
    return match ? match[1] : '00:00:00';
  });
};

// =========================================================================
// PLAYER HOOK — перехват запуска видео ВНУТРИ Lampa
// =========================================================================
var PlayerHook = {
  init: function () {
    if (!window.Lampa || !Lampa.Player || !Lampa.Player.listener) {
      log('Player недоступен');
      return;
    }
    this._onPlayerStart = this._onPlayerStart.bind(this);
    this._onExternal = this._onExternal.bind(this);
    Lampa.Player.listener.follow('start', this._onPlayerStart);
    Lampa.Player.listener.follow('external', this._onExternal);
    log('PlayerHook установлен');
  },
  _onPlayerStart: function (data) {
    var videoUrl = (data && (data.url || data.video_url)) || '';
    if (!videoUrl) return;
    var askAlways = Lampa.Storage.get(STORAGE_KEYS.ASK_ALWAYS, true);
    if (!askAlways) {
      var device = this._getSelectedDevice();
      if (device) this._castToDevice(device, videoUrl);
      else noty('DLNA-устройство не выбрано. Обычное воспроизведение.', 'warning');
      return;
    }
    this._showChoiceModal(videoUrl);
  },
  _onExternal: function (data) {
    // Lampa уходит во внешний плеер (Android-интент) — предлагаем трансляцию вместо этого
    var videoUrl = '';
    try {
      videoUrl = (data && (data.url || (data.data && data.data.url))) || '';
    } catch (e) {}
    if (!videoUrl && window.dlna_cast_pending_url) videoUrl = window.dlna_cast_pending_url;
    if (!videoUrl) return;
    var self = this;
    if (window.Lampa && Lampa.Select && typeof Lampa.Select.show === 'function') {
      try {
        Lampa.Select.show({
          title: 'Внешний плеер или трансляция?',
          items: [
            { title: 'Открыть во внешнем плеере', value: 'native' },
            { title: 'Транслировать на ТВ (DLNA)', value: 'dlna' }
          ],
          onSelect: function (item) {
            if (item.value === 'dlna') {
              var device = self._getSelectedDevice();
              if (!device) { noty('DLNA-устройство не выбрано в настройках', 'warning'); return; }
              self._castToDevice(device, videoUrl);
            }
          }
        });
      } catch (e) { log('Select ошибка:', e); }
    }
  },
  _getSelectedDevice: function () {
    var manualIp = (Lampa.Storage.get(STORAGE_KEYS.MANUAL_IP, '') || '').trim();
    var devices = DeviceStore.read();
    var selectedIdx = parseInt(Lampa.Storage.get(STORAGE_KEYS.SELECTED_DEVICE, '-1'), 10);
    if (selectedIdx >= 0 && devices[selectedIdx]) return devices[selectedIdx];
    if (manualIp) return { ip: manualIp, friendlyName: 'TV ' + manualIp, controlURL: '/upnp/control/rendertransport1', serviceType: 'urn:schemas-upnp-org:service:AVTransport:1' };
    return null;
  },
  _showChoiceModal: function (videoUrl) {
    var self = this;
    if (window.Lampa && Lampa.Select && typeof Lampa.Select.show === 'function') {
      try {
        Lampa.Select.show({
          title: 'Куда воспроизвести видео?',
          items: [
            { title: 'Смотреть в плеере Lampa', value: 'native' },
            { title: 'Транслировать на ТВ (DLNA)', value: 'dlna' }
          ],
          onSelect: function (item) {
            if (item.value === 'dlna') {
              var device = self._getSelectedDevice();
              if (!device) { noty('DLNA-устройство не выбрано в настройках', 'warning'); return; }
              self._castToDevice(device, videoUrl);
            }
          }
        });
        return;
      } catch (e) { log('Select ошибка:', e); }
    }
  },
  _castToDevice: function (device, videoUrl) {
    // Запоминаем URL на случай события external
    window.dlna_cast_pending_url = videoUrl;
    var renderer = new DLNARenderer(device);
    renderer.play(videoUrl, 'Lampa Video').then(function () { StatusMonitor.start(); }).catch(function (err) {
      noty('Ошибка DLNA: ' + (err.message || err), 'error');
    });
  }
};

// =========================================================================
// PLAYER WIDGET (кнопка в плеере)
// =========================================================================
var PlayerWidget = {
  init: function () {
    if (!window.Lampa || !Lampa.Player || !Lampa.Player.listener) return;
    var self = this;
    Lampa.Player.listener.follow('start', function () {
      if (Lampa.Storage.get(STORAGE_KEYS.ENABLE_WIDGET, true)) self._addButton();
    });
    Lampa.Player.listener.follow('destroy', function () {
      self._removeButton();
    });
  },
  _addButton: function () {
    if (this._buttonAdded) return;
    var self = this;
    var attempts = 0;
    var interval = setInterval(function () {
      attempts++;
      var $panel = $('.player-panel, .player__panel, .player-panel__controls, .player-controls, .player__controls').first();
      if (!$panel.length) $panel = $('.player').first();
      if ($panel.length > 0) {
        clearInterval(interval);
        var $btn = $('<div class="dlna-cast-btn selector" style="display:inline-block;padding:0.6em;margin:0.3em;cursor:pointer;background:rgba(255,255,255,0.12);border-radius:0.5em;text-align:center;">' +
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.6em" height="1.6em"><path fill="white" d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/></svg>' +
          '<div style="font-size:0.7em;margin-top:0.2em;">DLNA</div></div>');
        $btn.on('hover:enter click', function () {
          self._onButtonClick();
        });
        $panel.append($btn);
        self._buttonAdded = true;
        log('Кнопка DLNA добавлена в плеер');
      } else if (attempts >= 30) {
        clearInterval(interval);
      }
    }, 500);
  },
  _removeButton: function () {
    $('.dlna-cast-btn').remove();
    this._buttonAdded = false;
  },
  _onButtonClick: function () {
    var playdata = window.Lampa && Lampa.Player && Lampa.Player.playdata ? Lampa.Player.playdata() : null;
    var videoUrl = playdata && playdata.url;
    if (!videoUrl && window.dlna_cast_pending_url) videoUrl = window.dlna_cast_pending_url;
    if (!videoUrl) { noty('Нет активного видео', 'warning'); return; }
    var device = PlayerHook._getSelectedDevice();
    if (!device) { noty('DLNA-устройство не выбрано', 'warning'); return; }
    PlayerHook._castToDevice(device, videoUrl);
  }
};

// =========================================================================
// STATUS MONITOR
// =========================================================================
var StatusMonitor = {
  _interval: null, _busy: false, _stoppedCount: 0,
  init: function () { var self = this; if (this._bound) return; this._bound = true;
    if (window.Lampa && Lampa.Player && Lampa.Player.listener) Lampa.Player.listener.follow('destroy', function () { /* DLNA продолжает играть независимо от локального плеера */ });
  },
  start: function () { this._stoppedCount = 0; if (this._interval) return; var self = this;
    this._interval = setInterval(function () {
      var state = window.dlna_cast_status; if (!state || !state.playing || state.paused || self._busy) return;
      var device = state.device || PlayerHook._getSelectedDevice(); if (!device) return;
      self._busy = true; new DLNARenderer(device).getStatus().then(function (status) {
        state.lastStatus = status; state.lastCheck = Date.now(); log('Статус ТВ:', status);
        if (status === 'STOPPED' || status === 'NO_MEDIA_PRESENT') {
          self._stoppedCount++;
          if (self._stoppedCount >= 2) {
            var auto = Lampa.Storage.get(STORAGE_KEYS.AUTO_RECONNECT, true);
            if (auto && state.url && state.reconnects < 3) {
              state.reconnects = (state.reconnects || 0) + 1; log('Автопереподключение', state.reconnects);
              return new DLNARenderer(device).play(state.url, state.title).catch(function (e) { noty('Автопереподключение не удалось: ' + e.message, 'error'); if (state.reconnects >= 3) state.playing = false; });
            }
            if (!auto || state.reconnects >= 3) { state.playing = false; noty('Воспроизведение на ТВ остановлено', 'info'); }
          }
        } else if (status === 'PLAYING') self._stoppedCount = 0;
      }).catch(function (e) { log('Мониторинг недоступен:', e.message); }).then(function () { self._busy = false; });
    }, 10000);
  },
  _startMonitoring: function () { this.start(); },
  _stopMonitoring: function () { if (this._interval) { clearInterval(this._interval); this._interval = null; } }
};

// =========================================================================
// ИНИЦИАЛИЗАЦИЯ
// =========================================================================
function init() {
  if (!window.Lampa) {
    log('Lampa недоступна');
    return;
  }
  addLang();
  initSettings();
  PlayerHook.init();
  PlayerWidget.init();
  StatusMonitor.init();
  // Проверяем бридж при старте — сразу видно в консоли, жив ли он
  Bridge.ping().then(function () {
    log('Бридж доступен:', Bridge.url());
  }).catch(function (err) {
    log('Бридж НЕ доступен (' + err.message + '). Укажите «Адрес бриджа» в настройках плагина.');
  });
  try {
    if (Lampa.Manifest && Lampa.Manifest.plugins) {
      Lampa.Manifest.plugins[PLUGIN_ID] = {
        type: 'plugin',
        version: PLUGIN_VERSION,
        name: 'DLNA Cast',
        component: PLUGIN_ID
      };
    }
  } catch (e) { log('Manifest ошибка', e); }
  log('Плагин загружен v' + PLUGIN_VERSION);
}

if (window.appready) {
  init();
} else if (window.Lampa && Lampa.Listener) {
  Lampa.Listener.follow('app', function (e) {
    if (e.type === 'ready') init();
  });
}
})();