<?php
// Tiny whitelisted ESPN proxy (fallback only; the app fetches ESPN directly when CORS allows).
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
$path = isset($_GET['p']) ? $_GET['p'] : '';
if (!preg_match('#^(football/(nfl|college-football)|basketball/nba|hockey/nhl|baseball/mlb)/(scoreboard|summary)$#', $path)) {
  http_response_code(400); echo '{"error":"path not allowed"}'; exit;
}
$q = [];
if (isset($_GET['event'])) { if (!ctype_digit($_GET['event'])) { http_response_code(400); echo '{"error":"bad event"}'; exit; } $q['event'] = $_GET['event']; }
if (isset($_GET['dates'])) { if (!preg_match('/^\d{8}(-\d{8})?$/', $_GET['dates'])) { http_response_code(400); echo '{"error":"bad dates"}'; exit; } $q['dates'] = $_GET['dates']; }
$url = 'https://site.api.espn.com/apis/site/v2/sports/' . $path . ($q ? '?' . http_build_query($q) : '');
$cache = sys_get_temp_dir() . '/gd_' . md5($url) . '.json';
$ttl = 10;
if (is_file($cache) && time() - filemtime($cache) < $ttl) { header('X-Cache: HIT'); readfile($cache); exit; }
$ch = curl_init($url);
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 12, CURLOPT_ENCODING => '', CURLOPT_USERAGENT => 'GameDayScoreboard/1.0']);
$body = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
if ($body === false || $code !== 200) {
  if (is_file($cache)) { header('X-Cache: STALE'); readfile($cache); exit; }
  http_response_code(502); echo '{"error":"upstream failed","status":' . intval($code) . '}'; exit;
}
@file_put_contents($cache, $body);
header('Cache-Control: max-age=' . $ttl);
header('X-Cache: MISS');
echo $body;
