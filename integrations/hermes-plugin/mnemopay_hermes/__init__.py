"""
MnemoPay plugin for Hermes Agent.

Gives Hermes persistent cognitive memory + micropayment wallet.
Hooks into pre_llm_call to inject recalled memories into every prompt.
"""

from .tools import register

__all__ = ["register"]
__version__ = "1.0.0"
