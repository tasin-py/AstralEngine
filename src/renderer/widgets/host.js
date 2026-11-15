// Opens every widget window from this one page so they all share one renderer process.
window.widgetApi.on('widgets:open', (id) => {
  window.open('widget.html?id=' + encodeURIComponent(id), id);
});
