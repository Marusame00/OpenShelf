// src/upnp.js — UPnP/DLNA media server: SSDP discovery + ContentDirectory.
//
// Two surfaces, same library:
//   - Ssdp discovery: joins the 239.255.255.250:1900 multicast group,
//     answers M-SEARCH for MediaServer:1 and announces NOTIFY alive.
//   - Device description + ContentDirectory: served on the existing HTTP
//     server through the `extra` handler (see createApp in httpapp.js).
//     SOAP Browse walks the SAME library.js/sortstore.js logic as the web
//     UI, so the per-folder sort memory applies to DLNA clients too.
//
// The HTTP stream endpoint (/api/stream) already does ranged serving, so
// DIDL <res> URLs point straight at it — no transcoding, as always.

import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fss from 'node:fs';
import {
  classify, compareEntries, applyManualOrder, mediaType,
} from './library.js';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaServer:1';
const CONTENT_DIR = 'urn:schemas-upnp-org:service:ContentDirectory:1';
const CONN_MGR = 'urn:schemas-upnp-org:service:ConnectionManager:1';
const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>\n';

export function setupUpnp({ roots, lib, store, port, log = console }) {
  const debug = process.env.OSHELF_DEBUG_SSDP
    ? (...a) => log.info('[ssdp]', ...a)
    : () => {};
  const lan = lanIp();
  const udn = stableUdn();
  const base = `http://${lan}:${port}`;
  log.info(`[upnp] advertising OpenShelf as MediaServer at ${base} (UDN ${udn})`);
  log.info('[upnp] if devices do not see OpenShelf, Windows "SSDP Discovery" (SSDPSRV) is holding port 1900 - stop it from an admin prompt: net stop SSDPSRV');

  const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  ssdp.on('error', (err) => {
    log.warn(`[upnp] ssdp socket error: ${err.message} (DLNA discovery disabled, HTTP still works)`);
  });
  ssdp.on('message', onSsdpMessage);
  void bindSock();

  async function bindSock() {
    // On Windows the OS "SSDP Discovery" service (ssdpsrv) binds per-interface
    // sockets on 1900; a wildcard 0.0.0.0 bind does NOT receive multicast on
    // those interfaces (only the OS service does). Binding to the LAN IP
    // directly gets us on the group where probes actually arrive. If the OS
    // holds that address exclusively, fall back to sending announcements
    // only — the send side of SSDP needs no port ownership.
    const ok = await new Promise((resolve) => {
      const onErr = (e) => {
        ssdp.off('error', onErr);
        log.warn(`[upnp] cannot bind ${SSDP_PORT} on ${lan}: ${e.message}`);
        log.warn(`[upnp]   -> discovery relies on NOTIFY alive announcements (sent every 60s)`);
        resolve(false);
      };
      ssdp.once('error', onErr);
      try {
        ssdp.bind(SSDP_PORT, lan, () => {
          ssdp.off('error', onErr);
          try { ssdp.addMembership(SSDP_ADDR, lan); } catch (e) { log.warn(`[upnp] multicast join failed: ${e.message}`); }
          resolve(true);
        });
      } catch (e) { onErr(e); }
    });
    if (ok) announce('ssdp:alive');
  }
  const notifyTimer = setInterval(() => announce('ssdp:alive'), 60_000);
  if (notifyTimer.unref) notifyTimer.unref();

  function announce(nts) {
    const headers = [
      'NOTIFY * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'CACHE-CONTROL: max-age=1800',
      `LOCATION: ${base}/upnp/device.xml`,
      'NT: ' + DEVICE_TYPE,
      `NTS: ${nts}`,
      serverHeader(),
      `USN: ${udn}::${DEVICE_TYPE}`,
      'BOOTID.UPNP.ORG: 1',
      '', '',
    ];
    const msg = Buffer.from(headers.join('\r\n'), 'utf8');
    try {
      ssdp.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR);
      // Unicast to the broadcast address reaches every LAN host even when
      // the AP/router drops multicast (a common SSDP failure mode). BubbleUPnP
      // keeps a listening socket on 1900, so this lands directly in it.
      ssdp.send(msg, 0, msg.length, SSDP_PORT, '255.255.255.255');
      debug('announce', nts, 'sent to', SSDP_ADDR + ' and broadcast');
    } catch (e) { log.warn(`[upnp] announce failed: ${e.message}`); }
  }

  function onSsdpMessage(msg, rinfo) {
    const text = msg.toString('utf8');
    if (!text.includes('M-SEARCH')) return;
    const stMatch = /^ST:\s*(.+)$/im.exec(text);
    const st = stMatch ? stMatch[1].trim() : DEVICE_TYPE;
    debug('M-SEARCH from', rinfo.address + ':' + rinfo.port, 'ST=' + st);
    if (st !== 'ssdp:all' && st !== 'upnp:rootdevice' && st !== DEVICE_TYPE && !st.includes(udn)) return;
    const reply = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      `DATE: ${new Date().toUTCString()}`,
      'EXT:',
      `LOCATION: ${base}/upnp/device.xml`,
      serverHeader(),
      `ST: ${st}`,
      `USN: ${udn}::${DEVICE_TYPE}`,
      'BOOTID.UPNP.ORG: 1',
      '', '',
    ].join('\r\n');
    ssdp.send(Buffer.from(reply, 'utf8'), 0, reply.length, rinfo.port, rinfo.address);
    debug('replied to', rinfo.address + ':' + rinfo.port);
  }

  // ---- HTTP handler installed via createApp({ extra }) ---------------------

  return async function upnpHandler(req, res, url) {
    const { pathname } = url;
    if (!pathname.startsWith('/upnp/')) return false; // not ours
    if (pathname === '/upnp/device.xml') return sendXml(res, deviceXml());
    if (pathname === '/upnp/scpd.xml') return sendXml(res, cdsScpdXml());
    if (pathname === '/upnp/cm_scpd.xml') return sendXml(res, cmScpdXml());

    if (pathname === '/upnp/control') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return true; }
      await handleControl(req, res, CONTENT_DIR);
      return true;
    }
    if (pathname === '/upnp/cm_control') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return true; }
      await handleControl(req, res, CONN_MGR);
      return true;
    }
    if (pathname === '/upnp/event') {
      if (req.method === 'SUBSCRIBE' || req.method === 'UNSUBSCRIBE') {
        res.writeHead(200, {
          SID: 'uuid:' + crypto.randomUUID(),
          TIMEOUT: 'Second-1800',
          SERVER: serverHeader().split('SERVER: ', 2)[1] || 'OpenShelf/0.1',
        });
        res.end();
        return true;
      }
      res.writeHead(405); res.end(); return true;
    }
    return true; // any other /upnp/* path is still ours
  };

  async function handleControl(req, res, serviceType) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4_000_000) { res.writeHead(413); res.end(); return; }
    }
    const soapAction = (req.headers.soapaction || '').replace(/"/g, '');
    const action = soapAction.split('#')[1] || '';
    try {
      let xml;
      if (serviceType === CONTENT_DIR) {
        switch (action) {
          case 'Browse': xml = await browseAction(body, req, res); break;
          case 'GetSearchCapabilities': xml = actionResponse(CONTENT_DIR, 'GetSearchCapabilities', '<SearchCaps></SearchCaps>'); break;
          case 'GetSortCapabilities': xml = actionResponse(CONTENT_DIR, 'GetSortCapabilities', '<SortCaps></SortCaps>'); break;
          case 'GetSystemUpdateID': xml = actionResponse(CONTENT_DIR, 'GetSystemUpdateID', '<Id>1</Id>'); break;
          case 'GetServiceDescription': xml = soapBody(CONTENT_DIR, 'GetServiceDescriptionResponse', cdsScpdXml()); break;
          default: return soapFault(res, 401, `Invalid Action: ${action || '(empty)'}`);
        }
      } else {
        switch (action) {
          case 'GetProtocolInfo': xml = actionResponse(CONN_MGR, 'GetProtocolInfo', '<Source>http-get:*:*:*</Source><Sink></Sink>'); break;
          case 'GetCurrentConnectionIDs': xml = actionResponse(CONN_MGR, 'GetCurrentConnectionIDs', '<ConnectionIDs></ConnectionIDs>'); break;
          default: return soapFault(res, 401, `Invalid Action: ${action || '(empty)'}`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(xml) });
      res.end(xml);
    } catch (err) {
      console.error('[upnp] control error:', err);
      soapFault(res, 501, 'Action Failed');
    }
  }

  /** Build the DIDL-Lite result for one Browse, applying the stored sort. */
  async function browseAction(body) {
    const objectId = soapField(body, 'ObjectID') || '0';
    const browseFlag = soapField(body, 'BrowseFlag') || 'BrowseDirectChildren';
    const startIdx = parseInt(soapField(body, 'StartingIndex') || '0', 10) || 0;
    const requested = parseInt(soapField(body, 'RequestedCount') || '0', 10) || 0;
    const result = objectId === '0'
      ? { didl: rootsToDidl(), total: roots.length }
      : await objectToDidl(objectId, browseFlag, startIdx, requested);
    const didl = `<?xml version="1.0" encoding="utf-8"?>\n<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${result.didl}</DIDL-Lite>`;
    const resp = `<Result>${xmlEscape(didl)}</Result><NumberReturned>${Math.min(result.total, requested || result.total)}</NumberReturned><TotalMatches>${result.total}</TotalMatches><UpdateID>1</UpdateID>`;
    return actionResponse(CONTENT_DIR, 'Browse', resp);
  }

  function rootsToDidl() {
    return roots.map((r) => containerXml(objectIdFor(r.path), '0', r.name, null)).join('');
  }

  async function objectToDidl(objectId, flag, startIdx, count) {
    const abs = objectIdToPath(objectId);
    if (!abs) return { didl: '', total: 0 };
    const info = rootInfoFor(abs);
    if (!info) return { didl: '', total: 0 };
    const st = await new Promise((res) => fss.stat(abs, (e, s) => res(e ? null : s)));
    if (!st) return { didl: '', total: 0 };
    if (!st.isDirectory()) {
      const rel = path.relative(info.path, abs).split(path.sep).join('/');
      const item = await itemXml(abs, info, rel, parentIdFor(abs));
      return flag === 'BrowseMetadata' ? { didl: item, total: 1 } : { didl: '', total: 0 };
    }
    const parentId = path.dirname(abs) === info.path || !path.relative(info.path, path.dirname(abs)) ? objectIdFor(info.path) : objectIdFor(path.dirname(abs));
    if (flag === 'BrowseMetadata') {
      const entries = await lib.list(abs);
      return { didl: containerXml(objectIdFor(abs), parentId, path.basename(abs), entries.length), total: 1 };
    }
    const entries = await lib.list(abs);
    const names = entries.map((e) => e.name);
    const eff = await store.effective(abs, names);
    const pref = eff.pref;
    let list;
    if (pref.key === 'manual' && eff.folder) {
      list = applyManualOrder(entries, pref.manualOrder || []);
    } else if (pref.key === 'manual') {
      list = [...entries].sort((a, b) => compareEntries(a, b, 'name', pref.dir));
    } else {
      if (pref.key === 'duration') await lib.enrichDurations(abs, entries);
      const addedMs = new Map(Object.entries(pref.added || {}));
      list = [...entries].sort((a, b) => compareEntries(a, b, pref.key, pref.dir, addedMs));
    }
    const total = list.length;
    const page = startIdx >= total ? [] : list.slice(startIdx, count > 0 ? startIdx + count : total);
    const ids = page.map(async (e) => e.isDir
      ? containerXml(objectIdFor(e.path), objectIdFor(abs), e.name, null)
      : await itemXml(e.path, info, path.relative(info.path, e.path).split(path.sep).join('/'), objectIdFor(abs)));
    return { didl: (await Promise.all(ids)).join(''), total };
  }

  async function itemXml(abs, info, rel, parentId) {
    const st = await new Promise((res) => fss.stat(abs, (e, s) => res(e ? null : s)));
    if (!st) return '';
    const name = path.basename(abs);
    const kind = classify(name, false);
    const cls = { video: 'object.item.videoItem', audio: 'object.item.audioItem', image: 'object.item.imageItem' }[kind] || 'object.item';
    const resUrl = `${base}/api/stream?root=${encodeURIComponent(info.id)}&path=${encodeURIComponent(rel)}`;
    const protocolInfo = `http-get:*:${mediaType(name)}:DLNA.ORG_OP=01`;
    const durXml = st.duration ? `<upnp:duration>${fmtDuration(st.duration)}</upnp:duration>` : '';
    return `<item id="${xmlEscape(objectIdFor(abs))}" parentID="${xmlEscape(parentId)}" restricted="1"><dc:title>${xmlEscape(name)}</dc:title><dc:date>${new Date(st.mtimeMs).toISOString().slice(0, 10)}</dc:date><upnp:class>${cls}</upnp:class>${durXml}<res protocolInfo="${xmlEscape(protocolInfo)}" size="${st.size}">${xmlEscape(resUrl)}</res></item>`;
  }

  // ---- object ids: base64url of the absolute path --------------------------

  function objectIdFor(abs) {
    return Buffer.from(abs, 'utf8').toString('base64url');
  }
  function objectIdToPath(oid) {
    try {
      const abs = Buffer.from(oid, 'base64url').toString('utf8');
      return path.resolve(abs);
    } catch { return null; }
  }
  function parentIdFor(abs) {
    const parent = path.dirname(abs);
    const info = rootInfoFor(abs);
    if (!info) return '0';
    const rel = path.relative(info.path, parent);
    return (!rel || (rel.startsWith('..'))) ? objectIdFor(info.path) : objectIdFor(parent);
  }

  function rootInfoFor(abs) {
    const lower = abs.toLowerCase();
    return roots.find((r) => lower === r.path.toLowerCase() || lower.startsWith(r.path.toLowerCase() + path.sep.toLowerCase()));
  }

  // ---- device / scpd xml ---------------------------------------------------

  function deviceXml() {
    const body = `<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device>
<deviceType>${DEVICE_TYPE}</deviceType>
<friendlyName>OpenShelf</friendlyName>
<manufacturer>OpenShelf</manufacturer>
<modelDescription>Self-hosted media server - direct streaming, per-folder sort memory</modelDescription>
<modelName>OpenShelf</modelName>
<modelNumber>0.1</modelNumber>
<UDN>${udn}</UDN>
<serviceList>
<service><serviceType>${CONTENT_DIR}</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/upnp/scpd.xml</SCPDURL><controlURL>/upnp/control</controlURL><eventSubURL>/upnp/event</eventSubURL></service>
<service><serviceType>${CONN_MGR}</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><SCPDURL>/upnp/cm_scpd.xml</SCPDURL><controlURL>/upnp/cm_control</controlURL><eventSubURL>/upnp/event</eventSubURL></service>
</serviceList>
<presentationURL>/</presentationURL>
</device>
</root>`;
    return XML_DECL + body;
  }

  function cdsScpdXml() {
    return XML_DECL + `<scpd xmlns="urn:schemas-upnp-org:service-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
<action><name>Browse</name><argumentList>
<argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
<argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
<argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
<argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
<argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
<argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
<argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
<argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
<argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
<argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
</argumentList></action>
<action><name>GetSearchCapabilities</name><argumentList><argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument></argumentList></action>
<action><name>GetSortCapabilities</name><argumentList><argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument></argumentList></action>
<action><name>GetSystemUpdateID</name><argumentList><argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument></argumentList></action>
<action><name>GetServiceDescription</name><argumentList><argument><name>ServiceDescription</name><direction>out</direction><relatedStateVariable>ServiceDescription</relatedStateVariable></argument></argumentList></action>
</actionList>
<serviceStateTable>
<stateVariable sendEvents="no"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
<stateVariable><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
<stateVariable><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
<stateVariable><name>ServiceDescription</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType><allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
</serviceStateTable>
</scpd>`;
  }

  function cmScpdXml() {
    return XML_DECL + `<scpd xmlns="urn:schemas-upnp-org:service-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
<action><name>GetProtocolInfo</name><argumentList><argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument><argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument></argumentList></action>
<action><name>GetCurrentConnectionIDs</name><argumentList><argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument></argumentList></action>
</actionList>
<serviceStateTable>
<stateVariable sendEvents="no"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
<stateVariable sendEvents="no"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
</serviceStateTable>
</scpd>`;
  }
}

// ---- helpers ---------------------------------------------------------------

export function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && i.address !== '127.0.0.1') return i.address;
    }
  }
  return '127.0.0.1';
}

export function stableUdn() {
  const seed = 'openshelf:' + (firstMac() || os.hostname() || 'standalone');
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `uuid:openshelf-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function firstMac() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.mac && i.mac !== '00:00:00:00:00:00') return i.mac.replace(/:/g, '');
    }
  }
  return null;
}

function serverHeader() {
  const plat = os.platform();
  const ver = os.version ? os.version() : '';
  return `SERVER: ${plat}/1.0 UPnP/1.1 OpenShelf/0.1${ver ? ' ' + ver : ''}`;
}

function containerXml(id, parentId, title, childCount) {
  const cc = childCount === null ? '' : ` childCount="${childCount}"`;
  return `<container id="${xmlEscape(id)}" parentID="${xmlEscape(parentId)}" restricted="1"${cc}><dc:title>${xmlEscape(title)}</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`;
}

function actionResponse(serviceType, action, inner) {
  return soapBody(serviceType, `${action}Response`, inner);
}

function soapBody(serviceType, envelopeName, inner) {
  return XML_DECL + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${envelopeName} xmlns:u="${serviceType}">${inner}</u:${envelopeName}></s:Body></s:Envelope>`;
}

function soapFault(res, code, desc) {
  const xml = XML_DECL + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${xmlEscape(desc)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
  res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
  res.end(xml);
}

function sendXml(res, xml) {
  res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(xml) });
  res.end(xml);
  // Must return true: upnpHandler's `return sendXml(...)` lines rely on a
  // truthy value so the router doesn't fall through to its 404 and
  // double-write (ERR_HTTP_HEADERS_SENT).
  return true;
}

/** Namespace-tolerant XML field extraction for SOAP bodies (value is URL-decoded). */
function soapField(body, name) {
  const m = new RegExp(`(?:[\\w-]+:)?${name}(?:[^>]*)>([\\s\\S]*?)<\\/`, 'i').exec(body);
  if (!m) return null;
  const val = m[1].trim();
  try { return decodeURIComponent(val); } catch { return val; }
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function fmtDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
