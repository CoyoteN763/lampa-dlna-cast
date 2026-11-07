#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DLNA Cast Bridge 3.1.0 — SSDP discovery, UPnP SOAP and HTTP/HLS proxy.
Python 3.8+, standard library only. Run on a host reachable by both Lampa and TV.
"""
import ipaddress
import json
import os
import re
import socket
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get('DLNA_BRIDGE_PORT', '8099'))
SSDP_ADDR = ('239.255.255.250', 1900)
SSDP_ST = ('upnp:rootdevice', 'ssdp:all',
           'urn:schemas-upnp-org:device:MediaRenderer:1')
AV_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1'
RC_SERVICE = 'urn:schemas-upnp-org:service:RenderingControl:1'
MAX_PROXY_URL = 8192
MAX_BODY = 1024 * 1024
USER_AGENT = 'LampaDLNABridge/3.1.0'


def fetch(url, timeout=4):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def local_name(tag):
    return tag.rsplit('}', 1)[-1].split(':')[-1]


def child_text(node, name, default=''):
    for child in node.iter():
        if local_name(child.tag) == name and child.text:
            return child.text.strip()
    return default


def parse_device_description(xml_data, ip, description_url=''):
    root = ET.fromstring(xml_data)
    base = child_text(root, 'URLBase', '') or description_url
    device_node = next((n for n in root.iter() if local_name(n.tag) == 'device'), root)
    result = {'ip': ip, 'friendlyName': child_text(device_node, 'friendlyName', ip)}
    for service in (n for n in root.iter() if local_name(n.tag) == 'service'):
        st = child_text(service, 'serviceType')
        cp = child_text(service, 'controlURL')
        if not st or not cp:
            continue
        absolute = urllib.parse.urljoin(base, cp)
        parsed = urllib.parse.urlsplit(absolute)
        # Keep path and query, but SOAP currently targets HTTP endpoints only.
        path = urllib.parse.urlunsplit(('', '', parsed.path or '/', parsed.query, ''))
        if 'AVTransport' in st:
            result.update(serviceType=st, controlURL=path,
                          controlHost=parsed.hostname or ip,
                          controlPort=parsed.port or (443 if parsed.scheme == 'https' else 80),
                          controlScheme=parsed.scheme or 'http')
        elif 'RenderingControl' in st:
            result.update(renderingControlURL=path,
                          renderingControlHost=parsed.hostname or ip,
                          renderingControlPort=parsed.port or (443 if parsed.scheme == 'https' else 80),
                          renderingControlScheme=parsed.scheme or 'http')
    return result


def ssdp_scan(timeout=5):
    devices, seen = {}, set()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(0.25)
    try:
        for st in SSDP_ST:
            packet = ('M-SEARCH * HTTP/1.1\r\n'
                      'HOST: 239.255.255.250:1900\r\n'
                      'MAN: "ssdp:discover"\r\nMX: 2\r\nST: %s\r\n\r\n' % st)
            try:
                sock.sendto(packet.encode('ascii'), SSDP_ADDR)
            except OSError:
                pass
        deadline = time.monotonic() + max(1, min(float(timeout), 20))
        while time.monotonic() < deadline:
            try:
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            text = data.decode('utf-8', 'ignore')
            headers = {}
            for line in text.splitlines()[1:]:
                if ':' in line:
                    k, v = line.split(':', 1)
                    headers[k.strip().lower()] = v.strip()
            location = headers.get('location')
            if not location:
                continue
            key = (addr[0], location)
            if key in seen:
                continue
            seen.add(key)
            try:
                xml_data = fetch(location, 4)
                dev = parse_device_description(xml_data, addr[0], location)
                if dev.get('controlURL'):
                    devices[addr[0]] = dev
            except Exception:
                continue
    finally:
        sock.close()
    return list(devices.values())


def soap(device, action, body, service_type=None, timeout=8):
    service_type = service_type or device.get('serviceType') or AV_SERVICE
    is_rc = service_type == RC_SERVICE or 'RenderingControl' in service_type
    host = device.get('renderingControlHost' if is_rc else 'controlHost') or device['ip']
    port = int(device.get('renderingControlPort' if is_rc else 'controlPort') or 80)
    scheme = device.get('renderingControlScheme' if is_rc else 'controlScheme') or 'http'
    path = device.get('renderingControlURL' if is_rc else 'controlURL') or '/'
    envelope = ('<?xml version="1.0" encoding="utf-8"?>'
                '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
                's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
                '<s:Body><u:{0} xmlns:u="{1}">{2}</u:{0}></s:Body></s:Envelope>').format(action, service_type, body)
    url = urllib.parse.urlunsplit((scheme, '{}:{}'.format(host, port), path, '', ''))
    req = urllib.request.Request(url, data=envelope.encode('utf-8'), headers={
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': '"{}#{}"'.format(service_type, action),
        'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as exc:
        result = exc.read().decode('utf-8', 'replace')
        if exc.code not in (400, 500):
            raise
    try:
        root = ET.fromstring(result)
        if any(local_name(n.tag) == 'Fault' for n in root.iter()):
            raise RuntimeError('SOAP Fault: ' + (child_text(root, 'faultstring', '') or result[:500]))
    except ET.ParseError:
        pass
    return result


def detect(ip, timeout=2):
    # First attempt SSDP description is preferred; fallback to known endpoint paths.
    paths = ['/upnp/control/rendertransport1', '/dmr/upnp/control/AVTransport1',
             '/MediaRenderer/AVTransport/Control', '/AVTransport/control',
             '/upnp/control/AVTransport1', '/avtransport/control', '/UDNA/AVTransport/control']
    for path in paths:
        dev = {'ip': ip, 'friendlyName': 'TV ' + ip, 'serviceType': AV_SERVICE,
               'controlURL': path, 'controlHost': ip, 'controlPort': 80, 'controlScheme': 'http'}
        try:
            soap(dev, 'GetTransportInfo', '<InstanceID>0</InstanceID>', AV_SERVICE, timeout)
            for rc in ['/upnp/control/rendercontrol1', '/dmr/upnp/control/RenderingControl1',
                       '/MediaRenderer/RenderingControl/Control', '/RenderingControl/control']:
                candidate = dict(dev, renderingControlURL=rc, renderingControlHost=ip,
                                 renderingControlPort=80, renderingControlScheme='http')
                try:
                    soap(candidate, 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>', RC_SERVICE, 1.5)
                    dev.update(renderingControlURL=rc, renderingControlHost=ip,
                               renderingControlPort=80, renderingControlScheme='http')
                    break
                except Exception:
                    continue
            return dev
        except Exception:
            continue
    return None


def validate_proxy_url(raw):
    if not raw or len(raw) > MAX_PROXY_URL:
        raise ValueError('invalid or oversized URL')
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('only absolute HTTP/HTTPS URLs are supported')
    host = parsed.hostname
    try:
        addresses = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError('cannot resolve upstream host') from exc
    for item in addresses:
        ip = ipaddress.ip_address(item[4][0])
        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            raise ValueError('upstream address is blocked for safety')
    return parsed


class Handler(BaseHTTPRequestHandler):
    server_version = 'DLNACastBridge/3.1.0'

    def log_message(self, fmt, *args):
        pass

    def send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == '/ping':
                self.send_json(200, {'ok': True, 'version': '3.1.0'})
            elif parsed.path == '/scan':
                devices = ssdp_scan(min(float(q.get('timeout', ['5'])[0]), 20))
                self.send_json(200, {'ok': True, 'devices': devices})
            elif parsed.path == '/detect':
                ip = q.get('ip', [''])[0].strip()
                if not ip:
                    self.send_json(400, {'ok': False, 'error': 'no ip'})
                    return
                self.send_json(200, {'ok': True, 'device': detect(ip)})
            elif parsed.path == '/proxy':
                self.proxy(q)
            else:
                self.send_json(404, {'ok': False, 'error': 'unknown endpoint'})
        except Exception as exc:
            if not self.wfile.closed:
                try: self.send_json(502, {'ok': False, 'error': str(exc)})
                except (BrokenPipeError, ConnectionResetError): pass

    def proxy(self, q):
        target = q.get('url', [''])[0]
        upstream = validate_proxy_url(target)
        headers = {'User-Agent': q.get('user_agent', [USER_AGENT])[0][:512] or USER_AGENT}
        referer = q.get('referer', [''])[0]
        if referer:
            headers['Referer'] = referer[:2048]
        cookie = q.get('cookie', [''])[0]
        authorization = q.get('authorization', [''])[0]
        if cookie: headers['Cookie'] = cookie[:8192]
        if authorization: headers['Authorization'] = authorization[:4096]
        for name in ('Range', 'If-Range'):
            value = self.headers.get(name)
            if value: headers[name] = value
        req = urllib.request.Request(target, headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=25)
        except urllib.error.HTTPError as exc:
            response = exc
        status = getattr(response, 'status', getattr(response, 'code', 200))
        content_type = response.headers.get('Content-Type', 'application/octet-stream')
        is_hls = 'mpegurl' in content_type.lower() or upstream.path.lower().endswith('.m3u8')
        if not is_hls:
            self.send_response(status)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', content_type)
            for h in ('Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag'):
                if response.headers.get(h): self.send_header(h, response.headers[h])
            self.end_headers()
            try:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk: break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                response.close()
            return
        data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('HLS playlist exceeds 2 MiB')
        # Rewrite HLS URI lines and URI="..." attributes so relative resources also use proxy.
        if is_hls:
            text = data.decode('utf-8-sig', 'replace')
            base = target
            def proxify(uri):
                absolute = urllib.parse.urljoin(base, uri.strip())
                return '/proxy?url=' + urllib.parse.quote(absolute, safe='') + ('&referer=' + urllib.parse.quote(referer, safe='') if referer else '') + ('&user_agent=' + urllib.parse.quote(headers['User-Agent'], safe='') if headers.get('User-Agent') else '') + ('&cookie=' + urllib.parse.quote(headers['Cookie'], safe='') if headers.get('Cookie') else '') + ('&authorization=' + urllib.parse.quote(headers['Authorization'], safe='') if headers.get('Authorization') else '')
            lines = []
            for line in text.splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith('#'):
                    lines.append(proxify(stripped))
                else:
                    line = re.sub(r'URI="([^"]+)"', lambda m: 'URI="' + proxify(m.group(1)) + '"', line)
                    lines.append(line)
            data = ('\n'.join(lines) + '\n').encode('utf-8')
            content_type = 'application/vnd.apple.mpegurl'
            status = 200
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Accept-Ranges', response.headers.get('Accept-Ranges', 'bytes'))
        self.send_header('Content-Type', content_type)
        for h in ('Content-Range', 'Last-Modified', 'ETag'):
            if response.headers.get(h): self.send_header(h, response.headers[h])
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        response.close()

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path != '/control':
            self.send_json(404, {'ok': False, 'error': 'unknown endpoint'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > MAX_BODY:
                raise ValueError('invalid request body size')
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            ip = payload['ip']
            # The SOAP destination is a TV on the LAN; do not accept arbitrary URL schemes/hosts.
            addr = ipaddress.ip_address(ip)
            if not (addr.is_private or addr.is_link_local):
                raise ValueError('SOAP target must be a private/LAN IP')
            control_host = payload.get('controlHost') or ip
            control_addr = ipaddress.ip_address(control_host)
            if not (control_addr.is_private or control_addr.is_link_local):
                raise ValueError('AVTransport host must be a private/LAN IP')
            rc_host = payload.get('renderingControlHost') or ip
            rc_addr = ipaddress.ip_address(rc_host)
            if not (rc_addr.is_private or rc_addr.is_link_local):
                raise ValueError('RenderingControl host must be a private/LAN IP')
            device = {'ip': ip, 'controlURL': payload.get('controlURL', '/'),
                      'serviceType': payload.get('serviceType', AV_SERVICE),
                      'controlHost': control_host, 'controlPort': int(payload.get('controlPort', 80)),
                      'controlScheme': payload.get('controlScheme', 'http'),
                      'renderingControlURL': payload.get('renderingControlURL', '/'),
                      'renderingControlHost': rc_host, 'renderingControlPort': int(payload.get('renderingControlPort', 80)),
                      'renderingControlScheme': payload.get('renderingControlScheme', 'http')}
            result = soap(device, payload['action'], payload.get('body', ''),
                          payload.get('serviceType', AV_SERVICE), timeout=8)
            self.send_json(200, {'ok': True, 'response': result})
        except Exception as exc:
            self.send_json(502, {'ok': False, 'error': str(exc)})


if __name__ == '__main__':
    print('DLNA Cast Bridge 3.1.0: http://0.0.0.0:%d' % PORT)
    print('Health check: http://127.0.0.1:%d/ping' % PORT)
    print('Restrict TCP/%d to trusted LAN clients in your firewall.' % PORT)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
