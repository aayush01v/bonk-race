#!/usr/bin/env python3
"""
Simple HTTP static server for Sim Race / Bonk.
Run:
    python3 server.py [port]
Defaults to port 8000 on 0.0.0.0.
"""
import os, sys
from http.server import SimpleHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
HOST = "0.0.0.0"

class DevHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Prevent aggressive browser caching during game development / testing
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    codespace_name = os.environ.get("CODESPACE_NAME")
    
    print("=" * 60)
    print("  SIM RACE / BONK - DEV & TEST SERVER (Python)")
    print("=" * 60)
    print(f"- Local URL:         http://localhost:{PORT}/")
    print(f"- Babylon 3D Client: http://localhost:{PORT}/sim-race-babylon.html")
    print(f"- WebGL1 Client:     http://localhost:{PORT}/sim-race-webgl.html")
    if codespace_name:
        print(f"- Codespace URL:     https://{codespace_name}-{PORT}.app.github.dev/")
        print('  (Set Port 8000 visibility to "Public" in the PORTS tab if sharing)')
    print("=" * 60)
    print(f"Serving files from: {os.getcwd()}")
    print("Press Ctrl+C to stop.\n")
    
    server = HTTPServer((HOST, PORT), DevHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
