import { FrontMatterCache, htmlToMarkdown, moment } from 'obsidian';
import { parseFilePath } from '../../filesystem';
import { parseHTML, serializeFrontMatter } from '../../util';
import { ZipEntryFile } from '../../zip';
import { NotionLink, NotionProperty, NotionPropertyType, NotionResolverInfo, YamlProperty } from './notion-types';
import {
	escapeHashtags,
	getNotionId,
	hoistChildren,
	parseDate,
	stripNotionId,
	stripParentDirectories,
} from './notion-utils';
import { ERR_INVALID_ENCRYPTION_STRENGTH } from '@zip.js/zip.js';

export async function readToMarkdown(info: NotionResolverInfo, file: ZipEntryFile): Promise<string> {
	const text = await file.readText();

	const dom = parseHTML(text);
	// read the files etc.
	const body = dom.find('div[class=page-body]');

	const notionLinks = getNotionLinks(info, body);
	convertLinksToObsidian(info, notionLinks, true);

	let frontMatter: FrontMatterCache = {};

	const rawProperties = dom.find('table[class=properties] > tbody') as HTMLTableSectionElement | undefined;
	if (rawProperties) {
		const propertyLinks = getNotionLinks(info, rawProperties);
		convertLinksToObsidian(info, propertyLinks, false);
		// YAML only takes raw URLS
		convertHtmlLinksToURLs(rawProperties);

		for (let row of Array.from(rawProperties.rows)) {
			const property = parseProperty(row);
			if (property) {
				if (property.title == 'Tags') {
					property.title = 'tags';
					if (typeof property.content === 'string') {
						property.content = property.content.replace(/ /g, '-');
					}
					else if (property.content instanceof Array) {
						property.content = property.content.map(tag => tag.replace(/ /g, '-'));
					}
				}
				frontMatter[property.title] = property.content;
			}
		}
	}

	replaceNestedTags(body, 'strong');
	replaceNestedTags(body, 'em');
	fixNotionEmbeds(body);
	fixNotionCallouts(body);
	stripLinkFormatting(body);
	encodeNewlines(body, info);
	encodeSpaces(body, info);
	fixNotionDates(body);
	fixEquations(body);
	// Some annoying elements Notion throws in as wrappers, which mess up .md
	replaceElementsWithChildren(body, '.indented');
	replaceElementsWithChildren(body, 'details');
	fixToggleHeadings(body);
	fixNotionLists(body, 'ul');
	fixNotionLists(body, 'ol');
	fixNestedHr(body);

	addCheckboxes(body);
	replaceTableOfContents(body);
	formatDatabases(body);

	if (info.preserveColoredText) {
		matchColors(body);
	}

	let htmlString = body.innerHTML;
	
	// Simpler to just use the HTML string for this replacement
	htmlString = splitBrsInFormatting(htmlString, 'strong');
	htmlString = splitBrsInFormatting(htmlString, 'em');	

	let markdownBody = htmlToMarkdown(htmlString);
	if (info.singleLineBreaks) {		
		// (?!>) is making sure that any blockquote is preceded by an empty line (otherwise messes up formatting with consecutive blockquotes / callouts)
		markdownBody = markdownBody.replace(/\n *\n(?!>)/g, '\n');
	}
	
	markdownBody = escapeHashtags(markdownBody);
	markdownBody = fixDoubleBackslash(markdownBody);

	const description = dom.find('p[class*=page-description]')?.textContent;
	if (description) markdownBody = description + '\n\n' + markdownBody;

	return serializeFrontMatter(frontMatter) + markdownBody;
}

function encodeSpaces(body: HTMLElement, info: NotionResolverInfo) {
	// Notion shows spaces as written, so hard-code them before conversion to Markdown
	for (let j = 0; j < body.childElementCount; j ++) {
		const childEl = body.children[j];
		if (childEl.tagName === 'A') continue;

		if (childEl.classList.contains('indented')) {
			// Add four spaces to the start of indented items
			let firstChild = childEl.firstElementChild;
			if (!firstChild) firstChild = childEl;
			firstChild.innerHTML = `${info.replacements.indentedBlocks}` + firstChild.innerHTML;
		}
		if (childEl.childElementCount === 0 && childEl.textContent) {
			let lines = childEl.innerHTML.split('\n');
			for (let i = 0; i < lines.length; i ++) {
				let line = lines[i]

				let j = 0;
				while (/ /.test(line[j])) {
					j++;
				}

				if (j > 0) {
					const startSpaces = []
					for (let k = 0; k < j; k ++) {
						startSpaces.push(info.replacements.leadingSpaces)
					}
					line = startSpaces.join('') + line.slice(j);
				}
				line = line.replace(/ /g, '&#32;').replace(/\t/g, '&emsp;');
				lines[i] = line
			}
			childEl.innerHTML = lines.join('\n')
		}
		else if (childEl instanceof HTMLElement) encodeSpaces(childEl, info);
	}
}

function fixNestedHr(body: HTMLElement) {
	// HR items can show up in nested blocks in Notion. This is a fix to make nested HRs look better in Obsidian
	const firstHR = body.firstElementChild;
	if (firstHR?.tagName === 'HR') firstHR.replaceWith('<hr>\n');
	const nestedHRs = body.findAll('hr');
	for (let hr of nestedHRs.filter(hr => hr.parentElement && hr.parentElement !== body)) {
		hr.replaceWith('<hr>');
	}
}

function htmlToClassNames(el: HTMLElement) {
	// Lift any formatting into the class of a formatted <span>
	const classList: string[] = [];

	function replaceClass(child: Element | null, className: string) {
		if (child) {
			classList.push(className);
			hoistChildren(child);
		}
	}
	
	replaceClass(el.matchParent('[style*=border-bottom]'), 'cm-underline');
	replaceClass(el.find('[style*=border-bottom]'), 'cm-underline');

	replaceClass(el.matchParent('strong'), 'cm-strong');
	replaceClass(el.find('strong'), 'cm-strong');

	replaceClass(el.matchParent('em'), 'cm-italic');
	replaceClass(el.find('em'), 'cm-italic');

	return classList.join(' ');
}

// Notion's default colors
const colorToRgb: Record<string, string> = {
	gray: 'rgb(120, 119, 116)',
	brown: 'rgb(159, 107, 83)',
	orange: 'rgb(217, 115, 13)',
	yellow: 'rgb(203, 145, 47)',
	teal: 'rgb(68, 131, 97)',
	blue: 'rgb(51, 126, 169)',
	purple: 'rgb(144, 101, 176)',
	pink: 'rgb(193, 76, 138)',
	red: 'rgb(212, 76, 71)',
};

function matchColors(body: HTMLElement) {
	// Notion supports colored text, so use HTML to preserve it.
	const highlightedMarks = body.findAll('mark');  
	const coloredMarks = highlightedMarks.filter(mark => mark.className.includes('highlight-'));
	for (let mark of coloredMarks) {
		const color = mark.className.match(/highlight-([\w]+)/)?.[1];
		if (!color || !colorToRgb[color]) {
			hoistChildren(mark);
		}
		else {
			const previousElement = mark.previousElementSibling;
			console.log('prev', previousElement);
			
			let previousText = '';
			if (previousElement && previousElement.nodeType === previousElement.TEXT_NODE && previousElement.textContent) {
				previousText = previousElement.textContent;
				previousElement.remove();
			}
			mark.replaceWith(`<span class="${htmlToClassNames(mark)}" style="color: ${colorToRgb[color]};">${previousText}${mark.innerHTML.replace(/&#32;/g, ' ')}</span>`);
		}
	}
}

const typesMap: Record<NotionProperty['type'], NotionPropertyType[]> = {
	checkbox: ['checkbox'],
	date: ['created_time', 'last_edited_time', 'date'],
	list: ['file', 'multi_select', 'relation'],
	number: ['number', 'auto_increment_id'],
	text: [
		'email',
		'person',
		'phone_number',
		'text',
		'url',
		'status',
		'select',
		'formula',
		'rollup',
		'last_edited_by',
		'created_by',
	],
};

function parseProperty(property: HTMLTableRowElement): YamlProperty | undefined {
	const notionType = property.className.match(/property-row-(.*)/)?.[1] as NotionPropertyType;
	if (!notionType) {
		throw new Error('property type not found for: ' + property);
	}

	const title = htmlToMarkdown(property.cells[0].textContent ?? '');

	const body = property.cells[1];

	let type = Object.keys(typesMap).find((type: keyof typeof typesMap) =>
		typesMap[type].includes(notionType)
	) as NotionProperty['type'];

	if (!type) throw new Error('type not found for: ' + body);

	let content: YamlProperty['content'] = '';

	switch (type) {
		case 'checkbox':
			// checkbox-on: checked, checkbox-off: unchecked.
			content = body.innerHTML.includes('checkbox-on');
			break;
		case 'number':
			content = Number(body.textContent);
			if (isNaN(content)) return;
			break;
		case 'date':
			fixNotionDates(body);
			const dates = body.getElementsByTagName('time');
			if (dates.length === 0) {
				content = '';
			}
			else if (dates.length === 1) {
				content = parseDate(moment(dates.item(0)?.textContent));
			}
			else {
				const dateList = [];
				for (let i = 0; i < dates.length; i++) {
					dateList.push(
						parseDate(moment(dates.item(i)?.textContent))
					);
				}
				content = dateList.join(' - ');
			}
			if (content.length === 0) return;
			break;
		case 'list':
			const children = body.children;
			const childList: string[] = [];
			for (let i = 0; i < children.length; i++) {
				const itemContent = children.item(i)?.textContent;
				if (!itemContent) continue;
				childList.push(itemContent);
			}
			content = childList;			
			if (content.length === 0) return;
			break;
		case 'text':
			content = body.textContent ?? '';
			if (content.length === 0) return;
			break;
	}

	return {
		title,
		content,
	};
}

function getNotionLinks(info: NotionResolverInfo, body: HTMLElement) {
	const links: NotionLink[] = [];

	for (const a of body.findAll('a') as HTMLAnchorElement[]) {
		const decodedURI = stripParentDirectories(
			decodeURI(a.getAttribute('href') ?? '')
		);
		const id = getNotionId(decodedURI);

		const attachmentPath = Object.keys(info.pathsToAttachmentInfo)
			.find(filename => filename.includes(decodedURI));
		if (id && decodedURI.endsWith('.html')) {
			links.push({ type: 'relation', a, id });
		}
		else if (attachmentPath) {
			links.push({
				type: 'attachment',
				a,
				path: attachmentPath,
			});
		}
	}

	return links;
}

function fixDoubleBackslash(markdownBody: string) {
	// Persistent error during conversion where backslashes in full-path links written as '\\|' become double-slashes \\| in the markdown.
	// In tables, we have to use \| in internal links. This corrects the erroneous \\| in markdown.

	const slashSearch = /\[\[[^\]]*(\\\\)\|[^\]]*\]\]/;
	const doubleSlashes = markdownBody.match(new RegExp(slashSearch, 'g'));
	doubleSlashes?.forEach((slash) => {
		markdownBody = markdownBody.replace(
			slash,
			slash.replace(/\\\\\|/g, '\u005C|')
		);
	});

	return markdownBody;
}

function fixEquations(body: HTMLElement) {
	const katexEls = body.findAll('.katex');
	for (const katex of katexEls) {
		const annotation = katex.find('annotation');
		if (!annotation) continue;
		annotation.setText(`$${annotation.textContent}$`);
		katex.replaceWith(annotation);
	}
}

function stripToSentence(paragraph: string) {
	const firstSentence = paragraph.match(/^[^\.\?\!\n]*[\.\?\!]?/)?.[0];
	return firstSentence ?? '';
}

function isCallout(element: Element) {
	return !!(/callout|bookmark/.test(element.getAttribute('class') ?? ''));
}

function fixNotionCallouts(body: HTMLElement) {
	for (let callout of body.findAll('figure.callout')) {
		const description = callout.children[1].textContent;
		let calloutBlock = `> [!important]\n> ${description}\n`;
		if (callout.nextElementSibling && isCallout(callout.nextElementSibling)) {
			calloutBlock += '\n';
		}
		callout.replaceWith(calloutBlock);
	}
}

function fixNotionEmbeds(body: HTMLElement) {
	// Notion embeds are a box with images and description, we simplify for Obsidian.
	for (let embed of body.findAll('a.bookmark.source')) {
		const link = embed.getAttribute('href');
		const title = embed.find('div.bookmark-title')?.textContent;
		const description = stripToSentence(embed.find('div.bookmark-description')?.textContent ?? '');
		let calloutBlock = `> [!info] ${title}\n` + `> ${description}\n` + `> [${link}](${link})\n`;
		if (embed.nextElementSibling && isCallout(embed.nextElementSibling)) {
			// separate callouts with spaces
			calloutBlock += '\n';
		}
		embed.replaceWith(calloutBlock);
	}
}

function formatDatabases(body: HTMLElement) {
	// Notion includes user SVGs which aren't relevant to Markdown, so change them to pure text.
	for (const user of body.findAll('span[class=user]')) {
		user.innerText = user.textContent ?? '';
	}

	for (const checkbox of body.findAll('td div[class*=checkbox]')) {
		const newCheckbox = createSpan();
		newCheckbox.setText(checkbox.hasClass('checkbox-on') ? 'X' : '');
		checkbox.replaceWith(newCheckbox);
	}

	for (const select of body.findAll('table span[class*=selected-value]')) {
		const lastChild = select.parentElement?.lastElementChild;
		if (lastChild === select) continue;
		select.setText(select.textContent + ', ');
	}

	for (const a of body.findAll('a[href]') as HTMLAnchorElement[]) {
		// Strip URLs which aren't valid, changing them to normal text.
		if (!/^(https?:\/\/|www\.)/.test(a.href)) {
			const strippedURL = createSpan();
			strippedURL.setText(a.textContent ?? '');
			a.replaceWith(strippedURL);
		}
	}
}

function replaceNestedTags(body: HTMLElement, tag: 'strong' | 'em') {
	for (const el of body.findAll(tag)) {
		if (!el.parentElement || el.parentElement.tagName === tag.toUpperCase()) {
			continue;
		}
		let firstNested = el.find(tag);
		while (firstNested) {
			hoistChildren(firstNested);
			firstNested = el.find(tag);
		}
	}
}

function splitBrsInFormatting(htmlString: string, tag: 'strong' | 'em') {
	const tags = htmlString.match(new RegExp(`<${tag}>(.|\n)*</${tag}>`));
	if (!tags) return htmlString;
	for (let tag of tags.filter((tag) => tag.contains('<br />'))) {
		htmlString = htmlString.replace(
			tag,
			tag.split('<br />').join(`</${tag}><br /><${tag}>`)
		);
	}

	return htmlString
}

function replaceTableOfContents(body: HTMLElement) {
	const tocLinks = body.findAll('a[href*=\\#]') as HTMLAnchorElement[];
	for (const link of tocLinks) {
		if (link.getAttribute('href')?.startsWith('#')) {
			link.setAttribute('href', '#' + link.textContent);
		}
	}
}

function encodeNewlines(body: HTMLElement, info: NotionResolverInfo) {
	body.innerHTML = body.innerHTML.replace(/\n/g, info.replacements.shiftEnter + '<br />');
	
	// Since <br /> is ignored in codeblocks, we replace with newlines
	for (const block of body.findAll('code')) {
		for (const br of block.findAll('br')) {
			br.replaceWith('\n')
		}
	}
}

function stripLinkFormatting(body: HTMLElement) {
	for (const link of body.findAll('link')) {
		link.innerText = link.textContent ?? '';
	}
}

function fixNotionDates(body: HTMLElement) {
	// Notion dates always start with @
	for (const time of body.findAll('time')) {
		time.textContent = time.textContent?.replace(/@/g, '') ?? '';
	}
}

const fontSizeToHeadings: Record<string, 'h1' | 'h2' | 'h3'> = {
	'1.875em': 'h1',
	'1.5em': 'h2',
	'1.25em': 'h3',
};

function fixToggleHeadings(body: HTMLElement) {
	const toggleHeadings = body.findAll('summary');
	for (const heading of toggleHeadings) {
		const style = heading.getAttribute('style');
		if (style) {
			for (const key of Object.keys(fontSizeToHeadings)) {
				if (style.includes(key)) {
					heading.replaceWith(createEl(fontSizeToHeadings[key], { text: heading.textContent ?? '' }));
					break;
				}
			}
		}
		else {
			hoistChildren(heading);
		}
	}
}

function replaceElementsWithChildren(body: HTMLElement, selector: string) {
	let els = body.findAll(selector);
	for (const el of els) {
		hoistChildren(el);
	}
}

function fixNotionLists(body: HTMLElement, tagName: 'ul' | 'ol') {
	// Notion creates each list item within its own <ol> or <ul>, messing up newlines in the converted Markdown. 
	// Iterate all adjacent <ul>s or <ol>s and replace each string of adjacent lists with a single <ul> or <ol>.
	for (const htmlList of body.findAll(tagName)) {
		const htmlLists: HTMLElement[] = [];
		const listItems: HTMLElement[] = [];
		let nextAdjacentList: HTMLElement = htmlList;

		while (nextAdjacentList.tagName === tagName.toUpperCase()) {
			htmlLists.push(nextAdjacentList);
			for (let i = 0; i < nextAdjacentList.children.length; i++) {
				listItems.push(nextAdjacentList.children[i] as HTMLElement);
			}
			// classes are always "to-do-list, bulleted-list, or numbered-list"
			if (!nextAdjacentList.nextElementSibling || nextAdjacentList.getAttribute('class') !== nextAdjacentList.nextElementSibling.getAttribute('class')) break;
			nextAdjacentList = nextAdjacentList.nextElementSibling as HTMLElement;
		}

		const joinedList = body.createEl(tagName);
		for (const li of listItems) {
			joinedList.appendChild(li);
		}

		htmlLists[0].replaceWith(joinedList);
		htmlLists.slice(1).forEach(htmlList => htmlList.remove());
	}
}

function addCheckboxes(body: HTMLElement) {
	for (let checkboxEl of body.findAll('.checkbox.checkbox-on')) {
		checkboxEl.replaceWith('[x] ');
	}
	for (let checkboxEl of body.findAll('.checkbox.checkbox-off')) {
		checkboxEl.replaceWith('[ ] ');
	}
}

function convertHtmlLinksToURLs(content: HTMLElement) {
	const links = content.findAll('a') as HTMLAnchorElement[];

	if (links.length === 0) return content;
	for (const link of links) {
		const span = createSpan();
		span.setText(link.getAttribute('href') ?? '');
		link.replaceWith(span);
	}
}

function convertLinksToObsidian(info: NotionResolverInfo, notionLinks: NotionLink[], embedAttachments: boolean) {
	for (let link of notionLinks) {
		let obsidianLink = createSpan();
		let linkContent: string;

		switch (link.type) {
			case 'relation':
				const linkInfo = info.idsToFileInfo[link.id];
				if (!linkInfo) {
					console.warn('missing relation data for id: ' + link.id);
					const { basename } = parseFilePath(
						decodeURI(link.a.getAttribute('href') ?? '')
					);

					linkContent = `[[${stripNotionId(basename)}]]`;
				}
				else {
					const isInTable = link.a.closest('table');
					linkContent = `[[${linkInfo.fullLinkPathNeeded
						? `${info.getPathForFile(linkInfo)}${linkInfo.title}${isInTable ? '\u005C' : ''}|${linkInfo.title}`
						: linkInfo.title
					}]]`;
				}
				break;
			case 'attachment':
				const attachmentInfo = info.pathsToAttachmentInfo[link.path];
				if (!attachmentInfo) {
					console.warn('missing attachment data for: ' + link.path);
					continue;
				}
				linkContent = `${embedAttachments ? '!' : ''}[[${attachmentInfo.fullLinkPathNeeded
					? attachmentInfo.targetParentFolder +
						attachmentInfo.nameWithExtension +
						'|' +
						attachmentInfo.nameWithExtension
					: attachmentInfo.nameWithExtension
				}]]`;
				break;
		}

		obsidianLink.setText(linkContent);
		link.a.replaceWith(obsidianLink);
	}
}
