import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import type { Logger } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connections } from './connections.ts';
import { DatabaseConnectionError } from './driver.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// A server that speaks only as far as the TLS upgrade of the MySQL protocol, with a certificate made here for the name "other.example":
// what the client does with a certificate for another name is the question, so no real server is needed. Keys are made at run time.

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const directory = tempDir('marmeon-mysql-tls-');
const certificate = (name: string) => {
  const key = join(directory, `${name}.key`);
  const crt = join(directory, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-subj', '/CN=other.example', '-days', '1', '-addext', 'subjectAltName=DNS:other.example'], { stdio: 'ignore' });
  return { key, crt };
};

const trusted = certificate('trusted');
const stranger = certificate('stranger');

/** The server's first packet: protocol 10, version, thread id, a salt, and the capabilities that include SSL. */
function handshake(): Buffer {
  const body = Buffer.concat([
    Buffer.from([10]),
    Buffer.from('8.4.0\0'),
    Buffer.from([1, 0, 0, 0]),
    Buffer.alloc(8, 'a'),
    Buffer.from([0]),
    Buffer.from([0x01, 0x8a]), // capabilities, lower: LONG_PASSWORD, PROTOCOL_41, SSL, SECURE_CONNECTION
    Buffer.from([255]),
    Buffer.from([2, 0]),
    Buffer.from([0x08, 0x00]), // capabilities, upper: PLUGIN_AUTH
    Buffer.from([21]),
    Buffer.alloc(10),
    Buffer.alloc(13, 'b'),
    Buffer.from('mysql_native_password\0'),
  ]);
  return Buffer.concat([Buffer.from([body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff, 0]), body]);
}

let server: Server;
let port = 0;
let secured = 0;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.write(handshake());
    // The client's answer is the short packet that asks for TLS; then the bytes are TLS.
    socket.once('data', (first: Buffer) => {
      // The 36 bytes of the request; the client's TLS handshake usually comes in the same chunk, so the rest is fed to the TLS socket first.
      const wrapper = new Duplex({
        read() {},
        write: (chunk, _encoding, done) => void socket.write(chunk, done),
      });
      if (first.length > 36) wrapper.push(first.subarray(36));
      socket.on('data', (chunk) => wrapper.push(chunk));
      socket.on('end', () => wrapper.push(null));
      const secure = new TLSSocket(wrapper, { isServer: true, key: readFileSync(trusted.key), cert: readFileSync(trusted.crt) });
      secure.on('error', () => {});
      secure.on('secure', () => {
        secured += 1;
        secure.destroy();
        socket.destroy();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

/** The first query on a connection to the stub, and what happened to its TLS. */
async function connect(parameters: string) {
  const before = secured;
  const url = `mysql://app:hunter2x@localhost:${port}/app?connect_timeout=5&${parameters}`;
  const connections = new Connections({ connections: { default: { driver: 'mysql', url } }, root: '/', logger: silent });
  try {
    const error = await sql`select 1`.execute(connections.get()).then(() => undefined, (caught: unknown) => caught as Error);
    return { error, secured: secured - before };
  } finally {
    await connections.destroy();
  }
}

const ca = (path: string) => `ssl-ca=${encodeURIComponent(path)}`;

describe('the TLS of a MySQL connection', () => {
  it('VERIFY_IDENTITY refuses a certificate made for another name than the host, though the CA is trusted', { timeout: 30_000 }, async () => {
    const { error } = await connect(`ssl-mode=VERIFY_IDENTITY&${ca(trusted.crt)}`);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect(error!.message).toMatch(/^\[marmeon:D11\] Could not connect to the database connection "default" \(mysql mysql:\/\/app:\*\*\*@localhost:\d+\/app\?ssl-mode=VERIFY_IDENTITY\): .*altnames/);
    expect(error!.message).not.toContain('hunter2x');
  });

  it('VERIFY_CA takes the same certificate: the CA is trusted, the name is not looked at', { timeout: 30_000 }, async () => {
    const { secured } = await connect(`ssl-mode=VERIFY_CA&${ca(trusted.crt)}`);
    expect(secured).toBe(1);
  });

  it('REQUIRED encrypts without verifying anything', { timeout: 30_000 }, async () => {
    const { secured } = await connect('ssl-mode=REQUIRED');
    expect(secured).toBe(1);
  });

  it('VERIFY_CA refuses a certificate of a CA it was not given', { timeout: 30_000 }, async () => {
    const { error, secured } = await connect(`ssl-mode=VERIFY_CA&${ca(stranger.crt)}`);
    expect(secured).toBe(0);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect(error!.message).toMatch(/self[- ]signed|unable to verify|certificate/i);
  });
});
