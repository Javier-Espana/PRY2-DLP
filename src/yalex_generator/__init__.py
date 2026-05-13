"""Compatibility shim for the existing `yalex_parser` package.

This module re-exports the current implementation under the new
`yalex_generator` package name so code can migrate gradually.
"""
from importlib import import_module
from types import ModuleType

_orig = import_module("yalex_parser")

# Re-export all public names from the original package
globals().update({k: getattr(_orig, k) for k in dir(_orig) if not k.startswith("_")})

# Also expose submodules commonly used
codegen = import_module("yalex_parser.codegen")
dfa = import_module("yalex_parser.dfa")
simulator = import_module("yalex_parser.simulator")

__all__ = [name for name in globals() if not name.startswith("_")]
