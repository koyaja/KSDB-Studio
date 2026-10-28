// Tunnel SSH local : 127.0.0.1:<port aléatoire> -> (serveur SSH) -> hôte:port de la base.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'ssh2';
import type { SshConfig } from '../shared/types';

export interface Tunnel {
  port: number;
  alive: () => boolean;
  close: () => void;
}

export function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function openTunnel(ssh: SshConfig, dstHost: string, dstPort: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let alive = false;
    let server: net.Server | null = null;
    const sockets = new Set<net.Socket>();

    const close = () => {
      alive = false;
      for (const s of sockets) s.destroy();
      server?.close();
      client.end();
    };

    client.on('ready', () => {
      alive = true;
      server = net.createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
          if (err) {
            sock.destroy();
            return;
          }
          sock.pipe(stream).pipe(sock);
          stream.on('error', () => sock.destroy());
          sock.on('error', () => stream.close());
        });
      });
      server.on('error', (e) => {
        close();
        reject(e);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as net.AddressInfo;
        resolve({ port: addr.port, alive: () => alive, close });
      });
    });
    client.on('error', (e) => {
      const was = alive;
      close();
      if (!was) reject(new Error(`Tunnel SSH : ${e.message}`));
    });
    client.on('close', () => {
      alive = false;
      server?.close();
    });

    try {
      client.connect({
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.user,
        password: ssh.auth === 'password' ? ssh.password : undefined,
        privateKey: ssh.auth === 'key' && ssh.keyPath ? fs.readFileSync(expandHome(ssh.keyPath)) : undefined,
        passphrase: ssh.auth === 'key' ? ssh.passphrase || undefined : undefined,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        tryKeyboard: ssh.auth === 'password',
      });
      if (ssh.auth === 'password')
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => ssh.password ?? '')));
    } catch (e) {
      reject(new Error(`Tunnel SSH : ${(e as Error).message}`));
    }
  });
}
