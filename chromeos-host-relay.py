#!/usr/bin/env python3
"""Relay a loopback-only host port to an Apple container's private IPv4 address."""

import argparse
import asyncio
import ipaddress
import sys


BUFFER_SIZE = 64 * 1024
CONNECT_TIMEOUT_SECONDS = 5


def port(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return parsed


def private_ipv4(value: str) -> str:
    address = ipaddress.ip_address(value)
    if address.version != 4 or not (address.is_private or address.is_loopback):
        raise argparse.ArgumentTypeError("target must be a private IPv4 address")
    return str(address)


async def pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(BUFFER_SIZE):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.write_eof()
        except (AttributeError, ConnectionError, OSError):
            pass


async def proxy_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    target_host: str,
    target_port: int,
) -> None:
    upstream_writer = None
    try:
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(target_host, target_port),
            timeout=CONNECT_TIMEOUT_SECONDS,
        )
        pumps = {
            asyncio.create_task(pump(reader, upstream_writer)),
            asyncio.create_task(pump(upstream_reader, writer)),
        }
        _, pending = await asyncio.wait(
            pumps,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)
    except (TimeoutError, ConnectionError, OSError) as error:
        peer = writer.get_extra_info("peername")
        print(f"relay connection from {peer!r} failed: {error}", file=sys.stderr, flush=True)
    finally:
        if upstream_writer is not None:
            upstream_writer.close()
        writer.close()


async def serve(listen_port: int, target_host: str, target_port: int) -> None:
    server = await asyncio.start_server(
        lambda reader, writer: proxy_connection(reader, writer, target_host, target_port),
        host="127.0.0.1",
        port=listen_port,
        reuse_address=True,
    )
    addresses = ", ".join(str(sock.getsockname()) for sock in server.sockets or ())
    print(
        f"host relay ready: {addresses} -> {target_host}:{target_port}",
        flush=True,
    )
    async with server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-port", required=True, type=port)
    parser.add_argument("--target-host", required=True, type=private_ipv4)
    parser.add_argument("--target-port", required=True, type=port)
    args = parser.parse_args()
    asyncio.run(serve(args.listen_port, args.target_host, args.target_port))


if __name__ == "__main__":
    main()
