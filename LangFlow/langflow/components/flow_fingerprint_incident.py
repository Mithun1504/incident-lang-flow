import hashlib
import json
from typing import Any

from langflow.custom import Component
from langflow.io import HandleInput, Output
from langflow.schema import Data


class FingerprintIncident(Component):
    display_name = "Fingerprint Incident"
    description = "Creates a deterministic fingerprint and Jira deduplication label."
    icon = "fingerprint"
    name = "FingerprintIncident"

    inputs = [HandleInput(name="incident", display_name="Normalized Incident", input_types=["Data", "JSON", "Message"], required=False)]
    outputs = [Output(display_name="Fingerprinted Incident", name="result", method="process")]

    @staticmethod
    def _dict(value: Any) -> dict:
        if hasattr(value, "data"):
            value = getattr(value, "data", None)
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return {}
        return {}

    def process(self) -> Data:
        incident = self._dict(self.incident)
        key = "|".join([
            str(incident.get("service") or "button-demo").strip().lower(),
            str(incident.get("route") or "unknown").strip(),
            str(incident.get("error_type") or "Error").strip(),
            str(incident.get("message") or "unknown").strip(),
        ])
        fingerprint = str(incident.get("fingerprint") or hashlib.sha256(key.encode("utf-8")).hexdigest())
        incident["fingerprint"] = fingerprint
        incident["fingerprint_prefix"] = fingerprint[:8]
        incident["dedup_label"] = f"incident-{fingerprint[:8]}"
        self.status = f"Correlated as {incident['dedup_label']}"
        return Data(data=incident)
