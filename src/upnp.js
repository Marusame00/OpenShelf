// src/upnp.js — UPnP/DLNA discovery and content-directory stub.
//
// This is deliberately *not implemented*: v1 targets browsers over plain
// HTTP. What exists here is the structure for the DLNA layer later, so
// implementing it does not require restructuring anything else.
//
// Two pieces a real implementation needs:
//
// 1. SSDP discovery (UDP multicast, 239.255.255.250:1900):
//    - Join the group with SO_REUSEADDR, answer M-SEARCH for
//      `urn:schemas-upnp-org:device:MediaServer:1`.
//    - Every 1800s (or on M-SEARCH), send NOTIFY alive with ssdp:alive
//      and the device description URL.
//    - Stop packets endpoint: `Cache-Control: max-age=1800` so TVs keep
//      re-discovering.
//
// 2. Device description + ContentDirectory service (SOAP/XML on this HTTP
//    server):
//    - /upnp/device.xml — root device with friendlyName "OpenShelf".
//    - /upnp/scpd.xml — ContentDirectory:1 SCPD (Browse, GetSearchCapabilities,
//      GetSortCapabilities, GetSystemUpdateID, GetServiceDescription).
//    - /upnp/control — SOAP POST with Browse action; map a folder path to
//      a DIDL-Lite <container> and files to <item> (res@protocolInfo =
//      "http-get:*:video/mp4:DLNA.ORG_OP=01"); honour the requested sort.
//    - /upnp/event/ContentDirectory — GENA eventing (BasicEvent.262146).
//
// Implementation notes:
//   - The HTTP layer (httpapp.js) already serves bytes with Range support —
//     exactly what DLNA clients need for streaming; the <res> URL can point
//     straight at /api/stream.
//   - The browse/sort logic (library.js + sortstore.js) is reusable as-is;
//     the DIDL-Lite walk is the only genuinely new code.
//   - The stream endpoint already returns video/x-matroska etc. — add
//     DLNA.org* attributes in Content-Type if strict compliance matters.
//   - Windows firewall may block the multicast socket; needs an inbound
//     rule for UDP 1900 on install.
export function startUpnp({ server, roots, lib, store }) {
  console.warn('[upnp] DLNA not yet implemented (v1 serves plain HTTP)');
}
