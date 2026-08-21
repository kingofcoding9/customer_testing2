// Amelia's Picalily live inventory connection.
//
// Fill in ONLY these two values from FloralPOSBridge:
// 1) Public Cloudflare Tunnel URL
// 2) Bridge Access Key
//
// Example tunnel URL: https://inventory.example.com
//
// IMPORTANT:
// This is direct-browser mode. Because this is a static JavaScript file, the access
// key can be viewed by visitors in browser developer tools. The bridge is read-only,
// but use Cloudflare rate limiting / firewall rules if the site will be public.

window.PICALILY_SHOP_CONFIG = {
    tunnelUrl: "https://picalilyinv.omni-sciencecom.com",
    accessKey: "7065244200",

    // Storefront behavior:
    refreshSeconds: 60,
    hideNonPositivePrice: true,
    initialProductsPerCategory: 18
};
