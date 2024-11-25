const { addonBuilder } = require("stremio-addon-sdk");
const cheerio = require("cherio");
const axios = require("axios");
const https = require("https");
const AdmZip = require("adm-zip");
const iconv = require("iconv-lite");

const axiosInstance = axios.create({
	httpsAgent: new https.Agent({ rejectUnauthorized: false }),
	headers: {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		Cookie: "sid=1",
	},
	timeout: 10000,
});

const manifest = {
	id: "org.titlovi",
	version: "1.0.0",
	name: "Titlovi.com",
	description: "Titlovi sa titlovi.com",
	types: ["movie", "series"],
	catalogs: [],
	resources: ["subtitles"],
};

const builder = new addonBuilder(manifest);

function mapLanguageToCode(imgSrc) {
	if (!imgSrc) return "hr";
	imgSrc = imgSrc.toLowerCase();

	if (imgSrc.includes("/hr3.png")) return "hr";
	if (imgSrc.includes("/rs3.png")) return "sr";
	if (imgSrc.includes("/ba3.png")) return "bs";
	if (imgSrc.includes("/en3.png")) return "en";
	if (imgSrc.includes("/si3.png")) return "sl";
	if (imgSrc.includes("/mk3.png")) return "mk";

	// Dodajemo logovanje za neprepoznate slike
	console.log("[LANG] Unrecognized flag image:", imgSrc);
	return "hr";
}

function cleanText(text) {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/đ/g, "dj")
		.replace(/Đ/g, "Dj")
		.replace(/ć/g, "c")
		.replace(/č/g, "c")
		.replace(/š/g, "s")
		.replace(/ž/g, "z")
		.replace(/Ć/g, "C")
		.replace(/Č/g, "C")
		.replace(/Š/g, "S")
		.replace(/Ž/g, "Z");
}

function detectEncoding(buffer) {
	// Proveri BOM markere
	if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
		return "utf-8";
	if (buffer[0] === 0xfe && buffer[1] === 0xff) return "utf-16be";
	if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf-16le";

	// Probaj detektovati na osnovu sadržaja
	const utf8Valid =
		buffer.toString("utf-8").includes("ž") ||
		buffer.toString("utf-8").includes("š") ||
		buffer.toString("utf-8").includes("č");

	if (utf8Valid) return "utf-8";
	return "windows-1250"; // Default encoding za ex-yu jezike
}

async function downloadAndProcessSubtitle(downloadUrl) {
	try {
		const response = await axiosInstance.get(downloadUrl, {
			responseType: "arraybuffer",
			maxRedirects: 5,
			headers: {
				Referer: "https://titlovi.com",
			},
		});

		if (response.status !== 200) {
			console.log(`[DOWNLOAD] Bad status code: ${response.status}`);
			return null;
		}

		if (response.data.length < 100) {
			console.log(
				`[DOWNLOAD] Subtitle content too small: ${response.data.length} bytes`
			);
			return null;
		}

		let subtitleContent;
		const contentType = response.headers["content-type"]?.toLowerCase();

		if (
			contentType?.includes("zip") ||
			contentType?.includes("octet-stream") ||
			response.headers["content-disposition"]?.includes(".zip")
		) {
			const zip = new AdmZip(response.data);
			const zipEntries = zip.getEntries();

			const subtitleEntry = zipEntries.find(
				(entry) =>
					entry.entryName.endsWith(".srt") || entry.entryName.endsWith(".sub")
			);

			if (!subtitleEntry) return null;
			subtitleContent = subtitleEntry.getData();
		} else if (
			contentType?.includes("text") ||
			response.headers["content-disposition"]?.match(/\.(srt|sub)$/i)
		) {
			subtitleContent = response.data;
		} else {
			return null;
		}

		// Detektuj i konvertuj encoding
		const encoding = detectEncoding(subtitleContent);
		const decodedContent = iconv.decode(subtitleContent, encoding);

		// Konvertuj u UTF-8 i base64
		return Buffer.from(decodedContent, "utf-8").toString("base64");
	} catch (error) {
		console.error("[DOWNLOAD] Error:", error.message);
		return null;
	}
}

async function searchSubtitles(query) {
	try {
		const encodedQuery = encodeURIComponent(query);
		const url = `https://titlovi.com/titlovi/?prijevod=${encodedQuery}`;

		const response = await axiosInstance.get(url);
		const $ = cheerio.load(response.data);

		const subtitles = [];

		for (const elem of $("ul.titlovi > li.subtitleContainer").toArray()) {
			const $elem = $(elem);
			const $titleLink = $elem.find("h3 a");
			const subtitlePageUrl = $titleLink.attr("href");

			if (!subtitlePageUrl) continue;

			const mediaId = subtitlePageUrl.split("-").pop()?.replace("/", "");
			if (!mediaId) continue;

			const title = $titleLink.text().trim();
			const downloadPath = `/download/?type=1&mediaid=${mediaId}`;
			const releaseInfo = $elem
				.find("h4")
				.first()
				.contents()
				.filter(function () {
					return this.type === "text";
				})
				.text()
				.trim();

			const langImg = $elem.find("img.lang").attr("src");
			const language = mapLanguageToCode(langImg || "");
			const fps = $elem.find(".fps").text().replace("fps:", "").trim();
			const downloads = $elem.find(".downloads").text().trim();
			const uploader = $elem.find(".dodao a").text().trim();

			const downloadUrl = `https://titlovi.com${downloadPath}`;
			const base64Content = await downloadAndProcessSubtitle(downloadUrl);

			if (base64Content) {
				subtitles.push({
					id: mediaId,
					title: cleanText(title),
					releaseInfo: cleanText(releaseInfo),
					fps: fps !== "N/A" ? fps : null,
					language,
					downloads: parseInt(downloads) || 0,
					uploader: cleanText(uploader),
					url: `data:application/x-subrip;base64,${base64Content}`,
				});
			}
		}

		return subtitles.sort((a, b) => b.downloads - a.downloads);
	} catch (error) {
		console.error("[SEARCH] Error:", error);
		return [];
	}
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
	try {
		const [imdbId, season, episode] = id.split(":");
		let searchQuery = imdbId;

		if (season && episode) {
			searchQuery += ` S${season.padStart(2, "0")}E${episode.padStart(2, "0")}`;
		}

		const subtitles = await searchSubtitles(searchQuery);

		const formattedSubtitles = subtitles.map((sub) => ({
			id: sub.id,
			url: sub.url,
			lang: sub.language,
			name: cleanText(
				[
					sub.title,
					sub.releaseInfo,
					sub.fps ? `[${sub.fps}]` : "",
					`Upload: ${sub.uploader}`,
					`DL: ${sub.downloads}`,
				]
					.filter(Boolean)
					.join(" - ")
			),
		}));

		return { subtitles: formattedSubtitles };
	} catch (error) {
		console.error("[HANDLER] Error:", error);
		return { subtitles: [] };
	}
});

module.exports = builder.getInterface();

if (require.main === module) {
	const { serveHTTP } = require("stremio-addon-sdk");
	const port = process.env.PORT || 3000;

	serveHTTP(builder.getInterface(), { port })
		.then(() => {
			console.log(`Addon server running on port ${port}`);
			console.log(
				`URL za dodavanje u Stremio: http://localhost:${port}/manifest.json`
			);
		})
		.catch((error) => {
			console.error("Failed to start server:", error);
		});
}
