## Installation

Follow these steps to install the `hierarchy_link` app:

```bash
cd ~/frappe-bench

# Get the app
bench get-app https://github.com/M7md5eir/hierarchy_link.git

# Build assets
bench build --app hierarchy_link

# Install app on your site
bench --site <your-site> install-app hierarchy_link

# Clear cache
bench --site <your-site> clear-cache
```

Finally, refresh your browser:

* Press **Ctrl + Shift + R** (hard reload)
