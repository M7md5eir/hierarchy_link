"""Install / migrate hooks for Hierarchy Link.

The hard work of registering the fieldtype is done at app-import time via
`hierarchy_link._fieldtype_patch`. The hooks here only need to clear caches
so the fresh patch is reflected in any pre-existing serialised meta.
"""

from __future__ import annotations

import frappe


def after_install() -> None:
	_refresh_caches()


def after_migrate() -> None:
	_refresh_caches()


def _refresh_caches() -> None:
	frappe.clear_cache(doctype="DocField")
	frappe.clear_cache(doctype="DocType")
