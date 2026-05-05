from setuptools import find_packages, setup

with open("requirements.txt") as f:
	install_requires = [line.strip() for line in f if line.strip()]

setup(
	name="hierarchy_link",
	version="0.0.1",
	description="Adds a hierarchical (tree) picker for Link fields in Frappe.",
	author="M7md5eir",
	author_email="m7md5eir@gmail.com",
	packages=find_packages(),
	zip_safe=False,
	include_package_data=True,
	install_requires=install_requires,
)
