app_name = "hierarchy_link"
app_title = "Hierarchy Link"
app_publisher = "M7md5eir"
app_description = "Adds 'Hierarchy Link' as a first-class fieldtype for Frappe DocTypes."
app_email = "m7md5eir@gmail.com"
app_license = "MIT"

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
app_include_css = "hierarchy_link.bundle.css"
app_include_js = "hierarchy_link.bundle.js"

# Installation
# ------------

after_install = "hierarchy_link.install.after_install"
after_migrate = "hierarchy_link.install.after_migrate"

# Validation hooks
# ----------------
# Reject any Hierarchy Link field whose `options` does not point to a DocType
# with `is_tree=1`. We attach to DocType / Custom Field / Customize Form
# (which is itself a DocType-shaped flow) so the check fires whether the
# field is authored from the DocType editor, Form Builder, Customize Form,
# or as a Custom Field.
doc_events = {
	"DocType": {
		"validate": "hierarchy_link._validation.validate_doctype_hierarchy_links",
	},
	"Custom Field": {
		"validate": "hierarchy_link._validation.validate_custom_field_hierarchy_link",
	},
	"Customize Form": {
		"validate": "hierarchy_link._validation.validate_customize_form_hierarchy_links",
	},
}
