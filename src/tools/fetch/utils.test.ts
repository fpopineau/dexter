import { describe, expect, test } from 'bun:test';
import { isPrivateOrReservedHost, validateURL } from './utils.js';

describe('validateURL — SSRF hardening', () => {
    test('accepts normal public URLs', () => {
        expect(validateURL('https://www.reuters.com/markets/')).toBe(true);
        expect(validateURL('http://example.com/page?q=1')).toBe(true);
        expect(validateURL('https://8.8.8.8/status')).toBe(true); // public IP literal
    });

    test('rejects non-web schemes', () => {
        expect(validateURL('file:///C:/Windows/win.ini')).toBe(false);
        expect(validateURL('ftp://example.com/x')).toBe(false);
        expect(validateURL('chrome://settings')).toBe(false);
        expect(validateURL('gopher://example.com')).toBe(false);
    });

    test('rejects loopback, private and reserved targets', () => {
        expect(validateURL('https://127.0.0.1/api')).toBe(false);
        expect(validateURL('https://127.1.2.3:4002/')).toBe(false); // IB Gateway port
        expect(validateURL('http://10.0.0.5/admin')).toBe(false);
        expect(validateURL('http://172.16.0.1/')).toBe(false);
        expect(validateURL('http://192.168.1.1/')).toBe(false);
        expect(validateURL('http://169.254.169.254/latest/meta-data/')).toBe(false); // cloud metadata
        expect(validateURL('http://100.64.0.1/')).toBe(false); // CGNAT
        expect(validateURL('http://localhost:5000/')).toBe(false);
        expect(validateURL('http://foo.localhost/')).toBe(false);
        expect(validateURL('http://gateway.internal/')).toBe(false);
        expect(validateURL('http://[::1]:8080/')).toBe(false);
        expect(validateURL('http://[fd00::1]/')).toBe(false);
        expect(validateURL('http://[::ffff:127.0.0.1]/')).toBe(false);
    });

    test('rejects credentials in the URL', () => {
        expect(validateURL('https://user:pass@example.com/')).toBe(false);
    });
});

describe('isPrivateOrReservedHost', () => {
    test('classifies boundaries correctly', () => {
        expect(isPrivateOrReservedHost('172.15.255.255')).toBe(false); // just below private
        expect(isPrivateOrReservedHost('172.16.0.0')).toBe(true);
        expect(isPrivateOrReservedHost('172.31.255.255')).toBe(true);
        expect(isPrivateOrReservedHost('172.32.0.0')).toBe(false); // just above
        expect(isPrivateOrReservedHost('9.255.255.255')).toBe(false);
        expect(isPrivateOrReservedHost('224.0.0.1')).toBe(true); // multicast
        expect(isPrivateOrReservedHost('example.com')).toBe(false);
    });
});
