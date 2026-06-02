window._paq = window._paq || [];
/* tracker methods like "setCustomDimension" should be called before "trackPageView" */
const uid = localStorage.getItem('moonKagariUsername') || localStorage.getItem('tetrio_lastUsername') || localStorage.getItem('lastUsername');
if (uid && (uid !== 'X-ANON')) {
	_paq.push(['setUserId', uid]);
}
_paq.push(['trackPageView']);
_paq.push(['enableLinkTracking']);
(function() {
	const u = '//moon.kagari.moe/';
	_paq.push(['setTrackerUrl', `${ u }satellite.php`]);
	_paq.push(['setSiteId', '3']);
	_paq.push(['enableHeartBeatTimer']);
	_paq.push(['disableAlwaysUseSendBeacon', 'true']);
	const d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0];
	g.type = 'text/javascript';
	g.async = true;
	g.defer = true;
	g.src = `${ u }lander.php`;
	s.parentNode.insertBefore(g, s);
})();
