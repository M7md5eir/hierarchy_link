__version__ = "0.0.9"

# Register "Hierarchy Link" as a first-class fieldtype in Frappe.
#
# Frappe's fieldtype list is hard-coded in `frappe.model.data_fieldtypes`,
# the database layer's `type_map`, and the `fieldtype` Select options on
# `DocField` / `Custom Field` / `Customize Form Field`. We monkey-patch all
# three at app-import time so that "Hierarchy Link" is treated identically to
# "Link" for storage / meta purposes and shows up natively in every fieldtype
# picker the framework exposes.
#
# The DB schema for a Hierarchy Link column is identical to a Link column
# (varchar(140) by default), so any existing query / report / fetch_from /
# list view continues to work unchanged when a field is migrated between
# the two types.
from . import _fieldtype_patch  # noqa: F401
