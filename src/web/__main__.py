"""`python -m src.web` — start the local dashboard and open it in a browser. Run this
when you want to work; there's no need to keep it running otherwise."""

import threading
import time
import webbrowser

import uvicorn

HOST = "127.0.0.1"
PORT = 8420


def _open_browser():
    time.sleep(1.0)  # give uvicorn a moment to bind before navigating to it
    webbrowser.open(f"http://{HOST}:{PORT}/")


if __name__ == "__main__":
    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run("src.web.app:app", host=HOST, port=PORT, reload=False)
