"""
Shared Environment Loader
-------------------------
Loads the project-level .env file so all Python modules share the same
configuration as the Node.js server.

Usage (at the top of any Python module):
    import env_loader  # noqa: F401  — side-effect import

This will load variables from the project root .env file into os.environ.
Existing environment variables are NOT overridden (system/shell values win).
"""

import os
from pathlib import Path

def _load_env():
    """Find and load the .env file from the project root."""
    # Project root is one level up from python_modules/
    project_root = Path(__file__).resolve().parent.parent
    env_file = project_root / ".env"

    if not env_file.exists():
        print(f"[env_loader] No .env file found at {env_file}")
        print(f"[env_loader] Copy .env.example to .env and fill in your values:")
        print(f"[env_loader]   cp .env.example .env")
        return

    try:
        from dotenv import load_dotenv
        load_dotenv(env_file, override=False)
        print(f"[env_loader] Loaded environment from {env_file}")
    except ImportError:
        # Fallback: manual .env parsing if python-dotenv is not installed
        print(f"[env_loader] python-dotenv not installed, using manual parser")
        _manual_load(env_file)


def _manual_load(env_file):
    """Simple .env parser as fallback when python-dotenv is not installed."""
    with open(env_file, "r") as f:
        for line in f:
            line = line.strip()
            # Skip comments and empty lines
            if not line or line.startswith("#"):
                continue
            # Split on first '='
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            # Remove surrounding quotes if present
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            # Don't override existing env vars
            if key not in os.environ:
                os.environ[key] = value


# Auto-load on import
_load_env()
