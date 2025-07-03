#!/usr/bin/env node
/* eslint-disable */

const { chromium } = require('playwright')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const fs = require('fs')
const path = require('path')

/**
 * ===================================================================================
 * BROWSER-SIDE EVALUATION SCRIPT BUNDLE
 * ===================================================================================
 * This object contains all the functions that will be executed in the browser's context.
 * They are passed to page.evaluate() and have no access to the Node.js environment.
 */
const browserScripts = {
  /**
   * This is the main analysis script. It performs a static analysis of the page,
   * identifying all components and their structures without interacting with them.
   */
  getInitialPageStructure: () => {
    // --- Configuration Constants ---
    const LIST_DETECTION_RATIO = 3
    const TRIVIAL_CLASS_REGEX =
      /^(p|m|w|h|bg|text|font|flex|grid|border|rounded|gap|items|justify|self|place)-|^(block|inline|hidden$)/
    const LIST_PLACEHOLDER = '_list_'
    const TEXT_TRUNCATE_LENGTH = 50

    // --- Helper Functions ---
    const getSelector = (el) => {
      if (!(el instanceof Element)) return ''
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`
      if (el.id) return `#${CSS.escape(el.id)}`
      const uniqueAttrs = ['name', 'aria-label', 'placeholder', 'title', 'alt']
      for (const attr of uniqueAttrs) {
        const attrValue = el.getAttribute(attr)
        if (attrValue) {
          const selector = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(attrValue)}"]`
          try {
            if (document.querySelectorAll(selector).length === 1) return selector
          } catch (e) {
            /* ignore */
          }
        }
      }
      let path = ''
      let currentEl = el
      while (currentEl && currentEl.parentElement) {
        let selector = currentEl.tagName.toLowerCase()
        if (currentEl.id) {
          selector = `#${CSS.escape(currentEl.id)}`
          path = selector + (path ? ' > ' + path : '')
          break
        }
        const siblings = Array.from(currentEl.parentElement.children)
        const sameTagSiblings = siblings.filter((sibling) => sibling.tagName === currentEl.tagName)
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(currentEl) + 1
          selector += `:nth-of-type(${index})`
        }
        path = selector + (path ? ' > ' + path : '')
        if (currentEl.tagName.toLowerCase() === 'body') break
        currentEl = currentEl.parentElement
      }
      return path ? `body > ${path}` : el.tagName.toLowerCase()
    }

    const getNearestHeading = (el) => {
      let current = el
      const headingTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
      while (current && current !== document.body) {
        let sibling = current.previousElementSibling
        while (sibling) {
          if (headingTags.has(sibling.tagName)) return sibling.textContent.trim()
          const foundHeading = sibling.querySelector('h1, h2, h3, h4, h5, h6')
          if (foundHeading) return foundHeading.textContent.trim()
          sibling = sibling.previousElementSibling
        }
        current = current.parentElement
        if (current && headingTags.has(current.tagName)) return current.textContent.trim()
      }
      return null
    }

    const getFingerprint = (element) => {
      const tagName = element.tagName.toLowerCase()
      if (['ul', 'ol', 'table'].includes(tagName)) return LIST_PLACEHOLDER
      if (
        [
          'button',
          'a',
          'input',
          'textarea',
          'select',
          'details',
          'img',
          'svg',
          'p',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'span',
        ].includes(tagName) ||
        element.children.length === 0
      ) {
        return tagName
      }
      const childFingerprints = Array.from(element.children).map(getFingerprint)
      const uniqueChildFingerprints = new Set(childFingerprints)
      if (
        element.children.length > 0 &&
        element.children.length / uniqueChildFingerprints.size >= LIST_DETECTION_RATIO
      ) {
        return LIST_PLACEHOLDER
      }
      let selfFingerprint = tagName
      const significantClasses = Array.from(element.classList)
        .filter((c) => !TRIVIAL_CLASS_REGEX.test(c))
        .sort()
        .join('.')
      if (significantClasses) selfFingerprint += `.${significantClasses}`
      return selfFingerprint + childFingerprints.join('')
    }

    // [NEW] Builds a nested heading tree from a flat list of content.
    const buildHeadingTree = (contentStream) => {
      const root = { children: [] } // A dummy root object
      const headingStack = [root] // A stack to keep track of the current parent, starting with the dummy root

      contentStream.forEach((item) => {
        const level = item.level || Infinity // Assign a level to text items to handle them easily

        // Pop from stack until we find a suitable parent for the new item
        while (headingStack.length > 1 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop()
        }
        const currentParent = headingStack[headingStack.length - 1]

        if (item.type === 'heading') {
          const newHeadingNode = {
            heading: item.text,
            content: [],
            children: [],
          }
          // Add a temporary level property for hierarchy building
          newHeadingNode._level = item.level

          currentParent.children.push(newHeadingNode)
          headingStack.push(newHeadingNode)
        } else if (item.type === 'text') {
          if (currentParent.content) {
            currentParent.content.push(item.text)
          } else {
            // This case handles text that appears before any heading
            if (!root.content) root.content = []
            root.content.push(item.text)
          }
        }
      })

      // Recursively clean up helper properties (_level) and empty arrays
      const cleanupTree = (node) => {
        delete node._level
        if (node.children && node.children.length === 0) {
          delete node.children
        }
        if (node.content && node.content.length === 0) {
          delete node.content
        }
        if (node.children) {
          node.children.forEach(cleanupTree)
        }
      }

      root.children.forEach(cleanupTree)

      let finalTree = root.children
      // Add any general text found before the first heading
      if (root.content && root.content.length > 0) {
        finalTree.unshift({ heading: 'general', content: root.content })
      }

      return finalTree
    }

    const traverseDOM = (element, results, isInHeader = false, contentStream) => {
      if (
        !element ||
        typeof element.tagName !== 'string' ||
        element.style.display === 'none' ||
        element.hasAttribute('data-scraper-visited')
      ) {
        return
      }
      element.setAttribute('data-scraper-visited', 'true')

      const isCurrentlyInHeader = isInHeader || element.tagName.toLowerCase() === 'header'
      const tagName = element.tagName.toLowerCase()

      if (
        !isCurrentlyInHeader &&
        (['ul', 'ol', 'table'].includes(tagName) || (tagName === 'div' && element.children.length > 0))
      ) {
        let isList = ['ul', 'ol', 'table'].includes(tagName)
        let listType = `${tagName}-list`

        if (!isList) {
          const fingerprints = Array.from(element.children).map((child) => getFingerprint(child))
          const uniqueFingerprints = new Set(fingerprints)
          if (element.children.length / uniqueFingerprints.size >= LIST_DETECTION_RATIO) {
            isList = true
            listType = 'fingerprint-list'
          }
        }

        if (isList) {
          const listData = {
            selector: getSelector(element),
            coordinates: JSON.stringify(element.getBoundingClientRect()),
            heading: getNearestHeading(element),
            type: listType,
            items: [],
          }
          const fingerprints = new Set()
          for (const child of Array.from(element.children)) {
            const fp = getFingerprint(child)
            if (!fingerprints.has(fp)) {
              fingerprints.add(fp)
              const itemResults = {}
              const itemContentStream = []
              traverseDOM(child, itemResults, false, itemContentStream)
              itemResults.text_content = buildHeadingTree(itemContentStream) // Build tree for list item
              listData.items.push({ fingerprint: fp.substring(0, 75) + '...', structure: itemResults })
            }
          }
          if (!results.lists) results.lists = []
          results.lists.push(listData)
          return
        }
      }

      const locatorInfo = {
        selector: getSelector(element),
        coordinates: JSON.stringify(element.getBoundingClientRect()),
        heading: getNearestHeading(element),
        text: element.textContent.trim(), // Capture text content for logout check
      }

      const interactiveTags = {
        button: 'buttons',
        a: 'links',
        input: 'inputs',
        textarea: 'inputs',
        select: 'inputs',
        details: 'details',
      }
      if (interactiveTags[tagName]) {
        locatorInfo.isInsideForm = element.closest('form') !== null

        if (tagName === 'a') {
          locatorInfo.href = element.href
          const isNavigational =
            element.href &&
            element.href.trim() !== '' &&
            !element.href.startsWith(window.location.href + '#') &&
            !element.href.startsWith('javascript:')
          const category = isCurrentlyInHeader ? 'header-links' : 'links'
          const nonNavCategory = isCurrentlyInHeader ? 'header-buttons' : 'buttons'
          const targetCategory = isNavigational ? category : nonNavCategory
          if (!results[targetCategory]) results[targetCategory] = []
          results[targetCategory].push(locatorInfo)
        } else {
          let category = interactiveTags[tagName]
          if (isCurrentlyInHeader && category === 'buttons') category = 'header-buttons'
          if (!results[category]) results[category] = []
          results[category].push(locatorInfo)
        }
        if (tagName !== 'details') return
      }

      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
        contentStream.push({ type: 'heading', level: parseInt(tagName.charAt(1)), text: element.textContent.trim() })
      } else if (!interactiveTags[tagName]) {
        const directText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 1)
          .map((node) => node.textContent.trim())
          .join(' ')

        if (directText) {
          const truncatedText =
            directText.substring(0, TEXT_TRUNCATE_LENGTH) + (directText.length > TEXT_TRUNCATE_LENGTH ? '...' : '')
          contentStream.push({ type: 'text', text: truncatedText })
        }
      }

      for (const child of Array.from(element.children)) {
        traverseDOM(child, results, isCurrentlyInHeader, contentStream)
      }
    }

    const finalResults = {}
    const contentStream = []
    traverseDOM(document.body, finalResults, false, contentStream)
    finalResults.text_content = buildHeadingTree(contentStream)

    document.querySelectorAll('[data-scraper-visited]').forEach((el) => el.removeAttribute('data-scraper-visited'))

    return finalResults
  },

  getRevealedElements: (beforeSnapshotSelectors) => {
    // ... [Self-contained helper functions - code is identical and omitted for brevity] ...
    const LIST_DETECTION_RATIO = 3
    const TRIVIAL_CLASS_REGEX =
      /^(p|m|w|h|bg|text|font|flex|grid|border|rounded|gap|items|justify|self|place)-|^(block|inline|hidden$)/
    const LIST_PLACEHOLDER = '_list_'
    const TEXT_TRUNCATE_LENGTH = 50
    const getSelector = (el) => {
      if (!(el instanceof Element)) return ''
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`
      if (el.id) return `#${CSS.escape(el.id)}`
      const uniqueAttrs = ['name', 'aria-label', 'placeholder', 'title', 'alt']
      for (const attr of uniqueAttrs) {
        const attrValue = el.getAttribute(attr)
        if (attrValue) {
          const selector = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(attrValue)}"]`
          try {
            if (document.querySelectorAll(selector).length === 1) return selector
          } catch (e) {}
        }
      }
      let path = ''
      let currentEl = el
      while (currentEl && currentEl.parentElement) {
        let selector = currentEl.tagName.toLowerCase()
        if (currentEl.id) {
          selector = `#${CSS.escape(currentEl.id)}`
          path = selector + (path ? ' > ' + path : '')
          break
        }
        const siblings = Array.from(currentEl.parentElement.children)
        const sameTagSiblings = siblings.filter((sibling) => sibling.tagName === currentEl.tagName)
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(currentEl) + 1
          selector += `:nth-of-type(${index})`
        }
        path = selector + (path ? ' > ' + path : '')
        if (currentEl.tagName.toLowerCase() === 'body') break
        currentEl = currentEl.parentElement
      }
      return path ? `body > ${path}` : el.tagName.toLowerCase()
    }
    const getNearestHeading = (el) => {
      return null
    }
    const getFingerprint = (element) => {
      const tagName = element.tagName.toLowerCase()
      if (['ul', 'ol', 'table'].includes(tagName)) return LIST_PLACEHOLDER
      if (
        [
          'button',
          'a',
          'input',
          'textarea',
          'select',
          'details',
          'img',
          'svg',
          'p',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'span',
        ].includes(tagName) ||
        element.children.length === 0
      ) {
        return tagName
      }
      const childFingerprints = Array.from(element.children).map(getFingerprint)
      const uniqueChildFingerprints = new Set(childFingerprints)
      if (
        element.children.length > 0 &&
        element.children.length / uniqueChildFingerprints.size >= LIST_DETECTION_RATIO
      ) {
        return LIST_PLACEHOLDER
      }
      let selfFingerprint = tagName
      const significantClasses = Array.from(element.classList)
        .filter((c) => !TRIVIAL_CLASS_REGEX.test(c))
        .sort()
        .join('.')
      if (significantClasses) selfFingerprint += `.${significantClasses}`
      return selfFingerprint + childFingerprints.join('')
    }
    const buildHeadingTree = (contentStream) => {
      const root = { children: [] }
      const headingStack = [root]
      contentStream.forEach((item) => {
        const level = item.level || Infinity
        while (headingStack.length > 1 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop()
        }
        const currentParent = headingStack[headingStack.length - 1]
        if (item.type === 'heading') {
          const newHeadingNode = { heading: item.text, content: [], children: [] }
          newHeadingNode._level = item.level
          currentParent.children.push(newHeadingNode)
          headingStack.push(newHeadingNode)
        } else if (item.type === 'text') {
          if (currentParent.content) {
            currentParent.content.push(item.text)
          } else {
            if (!root.content) root.content = []
            root.content.push(item.text)
          }
        }
      })
      const cleanupTree = (node) => {
        delete node._level
        if (node.children && node.children.length === 0) {
          delete node.children
        }
        if (node.content && node.content.length === 0) {
          delete node.content
        }
        if (node.children) {
          node.children.forEach(cleanupTree)
        }
      }
      root.children.forEach(cleanupTree)
      let finalTree = root.children
      if (root.content && root.content.length > 0) {
        finalTree.unshift({ heading: 'general', content: root.content })
      }
      return finalTree
    }
    const traverseDOMForDiff = (element, results, isInHeader = false, contentStream) => {
      if (
        !element ||
        typeof element.tagName !== 'string' ||
        element.style.display === 'none' ||
        element.hasAttribute('data-scraper-visited')
      ) {
        return
      }
      element.setAttribute('data-scraper-visited', 'true')
      const isCurrentlyInHeader = isInHeader || element.tagName.toLowerCase() === 'header'
      const tagName = element.tagName.toLowerCase()
      if (
        !isCurrentlyInHeader &&
        (['ul', 'ol', 'table'].includes(tagName) || (tagName === 'div' && element.children.length > 0))
      ) {
        let isList = ['ul', 'ol', 'table'].includes(tagName)
        let listType = `${tagName}-list`
        if (!isList) {
          const fingerprints = Array.from(element.children).map((child) => getFingerprint(child))
          const uniqueFingerprints = new Set(fingerprints)
          if (element.children.length / uniqueFingerprints.size >= LIST_DETECTION_RATIO) {
            isList = true
            listType = 'fingerprint-list'
          }
        }
        if (isList) {
          const listData = {
            selector: getSelector(element),
            coordinates: JSON.stringify(element.getBoundingClientRect()),
            heading: getNearestHeading(element),
            type: listType,
            items: [],
          }
          const fingerprints = new Set()
          for (const child of Array.from(element.children)) {
            const fp = getFingerprint(child)
            if (!fingerprints.has(fp)) {
              fingerprints.add(fp)
              const itemResults = {}
              const itemContentStream = []
              traverseDOMForDiff(child, itemResults, false, itemContentStream)
              itemResults.text_content = buildHeadingTree(itemContentStream)
              listData.items.push({ fingerprint: fp.substring(0, 75) + '...', structure: itemResults })
            }
          }
          if (!results.lists) results.lists = []
          results.lists.push(listData)
          return
        }
      }
      const locatorInfo = {
        selector: getSelector(element),
        coordinates: JSON.stringify(element.getBoundingClientRect()),
        heading: getNearestHeading(element),
        text: element.textContent.trim(),
      }
      const interactiveTags = {
        button: 'buttons',
        a: 'links',
        input: 'inputs',
        textarea: 'inputs',
        select: 'inputs',
        details: 'details',
      }
      if (interactiveTags[tagName]) {
        locatorInfo.isInsideForm = element.closest('form') !== null
        if (tagName === 'a') {
          locatorInfo.href = element.href
          const isNavigational =
            element.href && element.href.trim() !== '' && !element.href.startsWith(window.location.href + '#')
          const category = isCurrentlyInHeader ? 'header-links' : 'links'
          const nonNavCategory = isCurrentlyInHeader ? 'header-buttons' : 'buttons'
          const targetCategory = isNavigational ? category : nonNavCategory
          if (!results[targetCategory]) results[targetCategory] = []
          results[targetCategory].push(locatorInfo)
        } else {
          let category = interactiveTags[tagName]
          if (isCurrentlyInHeader && category === 'buttons') category = 'header-buttons'
          if (!results[category]) results[category] = []
          results[category].push(locatorInfo)
        }
        if (tagName !== 'details') return
      }
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
        contentStream.push({ type: 'heading', level: parseInt(tagName.charAt(1)), text: element.textContent.trim() })
      } else if (!interactiveTags[tagName]) {
        const directText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 1)
          .map((node) => node.textContent.trim())
          .join(' ')
        if (directText) {
          const truncatedText =
            directText.substring(0, TEXT_TRUNCATE_LENGTH) + (directText.length > TEXT_TRUNCATE_LENGTH ? '...' : '')
          contentStream.push({ type: 'text', text: truncatedText })
        }
      }
      for (const child of Array.from(element.children)) {
        traverseDOMForDiff(child, results, isCurrentlyInHeader, contentStream)
      }
    }

    const beforeSet = new Set(beforeSnapshotSelectors)
    const allCurrentElements = document.querySelectorAll('body *')
    const newRootElements = []
    const allNewElements = new Set()
    allCurrentElements.forEach((el) => {
      if (el.offsetParent !== null && !beforeSet.has(getSelector(el))) {
        allNewElements.add(el)
      }
    })
    allNewElements.forEach((el) => {
      let parentIsNew = false
      let parent = el.parentElement
      while (parent) {
        if (allNewElements.has(parent)) {
          parentIsNew = true
          break
        }
        parent = parent.parentElement
      }
      if (!parentIsNew) {
        newRootElements.push(el)
      }
    })

    const revealedData = {}
    const contentStream = []
    newRootElements.forEach((el) => {
      traverseDOMForDiff(el, revealedData, false, contentStream)
    })
    revealedData.text_content = buildHeadingTree(contentStream)

    document.querySelectorAll('[data-scraper-visited]').forEach((el) => el.removeAttribute('data-scraper-visited'))

    return revealedData
  },

  getAllVisibleSelectors: () => {
    // ... [Code is identical and omitted for brevity] ...
    const getSelector = (el) => {
      if (!(el instanceof Element)) return ''
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`
      if (el.id) return `#${CSS.escape(el.id)}`
      let path = ''
      let currentEl = el
      while (currentEl && currentEl.parentElement) {
        let selector = currentEl.tagName.toLowerCase()
        if (currentEl.id) {
          selector = `#${CSS.escape(currentEl.id)}`
          path = selector + (path ? ' > ' + path : '')
          break
        }
        const siblings = Array.from(currentEl.parentElement.children)
        const sameTagSiblings = siblings.filter((s) => s.tagName === currentEl.tagName)
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(currentEl) + 1
          selector += `:nth-of-type(${index})`
        }
        path = selector + (path ? ' > ' + path : '')
        if (currentEl.tagName.toLowerCase() === 'body') break
        currentEl = currentEl.parentElement
      }
      return path ? `body > ${path}` : el.tagName.toLowerCase()
    }
    return Array.from(document.querySelectorAll('body *:not([style*="display: none"])')).map((el) => getSelector(el))
  },
}

/**
 * ===================================================================================
 * NODE.JS CRAWLER SCRIPT
 * ===================================================================================
 */

function collectAllInteractables(node, path, interactablesList, depth) {
  if (!node || typeof node !== 'object') return
  const interactiveCategories = ['buttons', 'links', 'header-buttons', 'header-links', 'details']
  interactiveCategories.forEach((category) => {
    if (node[category] && Array.isArray(node[category])) {
      node[category].forEach((item, index) => {
        interactablesList.push({ component: item, path: [...path, category, index], depth })
      })
    }
  })
  if (node.lists && Array.isArray(node.lists)) {
    node.lists.forEach((list, listIndex) => {
      if (list.items && Array.isArray(list.items)) {
        list.items.forEach((listItem, itemIndex) => {
          if (listItem.structure) {
            collectAllInteractables(
              listItem.structure,
              [...path, 'lists', listIndex, 'items', itemIndex, 'structure'],
              interactablesList,
              depth
            )
          }
        })
      }
    })
  }
}

function setAtPath(obj, path, value) {
  let current = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (current[key] === undefined) {
      return
    }
    current = current[key]
  }
  const finalKey = path[path.length - 1]
  const component = current[finalKey]
  if (component) {
    if (!component.revealed) component.revealed = []
    component.revealed.push(value)
  }
}

async function setupAuthentication(context, argv) {
  console.log(`\n🔐 Setting up authentication via ${argv.tokenType}...`)

  const page = await context.newPage()
  try {
    await page.goto(argv.baseUrl, { waitUntil: 'domcontentloaded' })

    if (argv.tokenType === 'localStorage') {
      console.log(`  Injecting token into localStorage with key: "${argv.tokenKey}"`)
      await page.evaluate(
        ({ key, value }) => {
          localStorage.setItem(key, value)
        },
        { key: argv.tokenKey, value: argv.authToken }
      )
    } else if (argv.tokenType === 'cookie') {
      console.log(`  Injecting token as a cookie with name: "${argv.tokenKey}"`)
      await context.addCookies([
        {
          name: argv.tokenKey,
          value: argv.authToken,
          domain: new URL(argv.baseUrl).hostname,
          path: '/',
        },
      ])
    }

    console.log('  ✅ Authentication context prepared.')
  } catch (e) {
    console.error(`❌ Failed to set up authentication: ${e.message}`)
    throw new Error('Authentication setup failed.')
  } finally {
    await page.close()
  }
}

const main = async () => {
  let outputFilePath
  let browser
  const results = {}

  try {
    const argv = yargs(hideBin(process.argv))
      .option('port', {
        alias: 'p',
        type: 'number',
        description: 'The port number of the local React app',
        demandOption: true,
      })
      .option('output', {
        alias: 'o',
        type: 'string',
        description: 'Output file path for the JSON results',
        default: 'selectors.json',
      })
      .option('auth-token', { alias: 't', type: 'string', description: 'Authentication token (e.g., JWT)' })
      .option('token-key', {
        alias: 'k',
        type: 'string',
        description: 'The key for the token in localStorage or the cookie name',
        default: 'jwt',
      })
      .option('token-type', {
        alias: 'y',
        choices: ['localStorage', 'cookie'],
        description: 'How the token is stored in the browser',
        default: 'localStorage',
      })
      .check((argv) => {
        if (argv.authToken && !argv.tokenKey) {
          throw new Error('If using --auth-token (-t), you must also provide --token-key (-k).')
        }
        return true
      })
      .help()
      .alias('help', 'h').argv

    outputFilePath = argv.output
    const baseUrl = `http://localhost:${argv.port}`
    argv.baseUrl = baseUrl
    const initialUrl = `${baseUrl}/`
    const initialHostname = `localhost`

    const urlQueue = [initialUrl]
    const visitedUrls = new Set()

    console.log(`🚀 Scraper configured. Starting...`)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()

    if (argv.authToken) {
      await setupAuthentication(context, argv)
    }

    while (urlQueue.length > 0) {
      const currentUrl = new URL(urlQueue.shift()).href
      if (!currentUrl || visitedUrls.has(currentUrl)) {
        continue
      }
      visitedUrls.add(currentUrl)
      console.log(`\n🔎 Scraping and interacting with: ${currentUrl}`)

      const page = await context.newPage()
      try {
        await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 15000 })
      } catch (e) {
        console.error(`❌ Failed to load ${currentUrl}. Skipping.`)
        await page.close()
        continue
      }

      if (!results[currentUrl]) {
        const pageStructure = await page.evaluate(browserScripts.getInitialPageStructure)
        results[currentUrl] = pageStructure
      }

      const interactionQueue = []
      collectAllInteractables(results[currentUrl], [], interactionQueue, 0)

      console.log(`  📊 Found ${interactionQueue.length} initial interactable components on this page.`)

      while (interactionQueue.length > 0) {
        const queueItem = interactionQueue.shift()
        if (!queueItem) continue
        const { component, path, depth } = queueItem

        if (depth >= 7) {
          console.log(`  🚫 Reached max interaction depth (7). Skipping click on: ${component.selector}`)
          continue
        }

        if (component.text && /log out|sign out|logout|signout/i.test(component.text.replace(/\s/g, ''))) {
          console.log(`  🚫 Skipping potential logout button: ${component.selector}`)
          continue
        }

        if (component.isInsideForm || (component.selector && component.selector.startsWith('input'))) {
          console.log(`  🚫 Skipping component inside a form or an input: ${component.selector}`)
          continue
        }

        if (component.href) {
          try {
            const linkUrl = new URL(component.href, initialUrl)
            if (linkUrl.hostname !== initialHostname) {
              console.log(`  🔗 Skipping external link: ${component.href}`)
              continue
            }
          } catch (e) {
            console.warn(`  ⚠️ Could not parse URL from href: "${component.href}". Skipping.`)
            continue
          }
        }

        const beforeUrl = page.url()
        const beforeSnapshot = await page.evaluate(browserScripts.getAllVisibleSelectors)

        try {
          await page.locator(component.selector).first().click({ timeout: 5000, force: true })
          await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
        } catch (error) {
          console.warn(`⚠️ Could not click on ${component.selector}. It may be stale or unclickable. Skipping.`)
          continue
        }

        const afterUrl = page.url()

        if (new URL(beforeUrl).href !== new URL(afterUrl).href) {
          const newUrl = new URL(afterUrl)
          if (newUrl.hostname === initialHostname) {
            console.log(`  ➡️  Navigated to internal link: ${newUrl.href}`)
            if (!visitedUrls.has(newUrl.href)) {
              urlQueue.push(newUrl.href)
            }
          }
          await page.goBack({ waitUntil: 'networkidle' }).catch(() => console.warn('Could not go back.'))
        } else {
          const revealedData = await page.evaluate(browserScripts.getRevealedElements, beforeSnapshot)
          if (
            Object.keys(revealedData).length > 0 &&
            Object.values(revealedData).some((v) => (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0))
          ) {
            console.log(`  ✨ Revealed new components (depth ${depth + 1}) by clicking: ${component.selector}`)
            setAtPath(results[currentUrl], path, revealedData)

            const newInteractables = []
            const revealedComponentPath = [...path, 'revealed', (component.revealed?.length || 1) - 1]
            collectAllInteractables(revealedData, revealedComponentPath, newInteractables, depth + 1)

            if (newInteractables.length > 0) {
              console.log(`    - Found ${newInteractables.length} new interactable(s) in revealed content.`)
              interactionQueue.unshift(...newInteractables)
            }

            try {
              await page
                .locator(component.selector)
                .first()
                .click({ timeout: 1000 })
                .catch(() => page.mouse.click(0, 0))
            } catch (e) {
              await page.mouse.click(0, 0)
            }
            await page.waitForTimeout(250)
          }
        }
      }
      await page.close()
    }

    // [UPDATED] Use __dirname to ensure the output file is created next to the script
    const fullPath = path.resolve(__dirname, outputFilePath)
    fs.writeFileSync(fullPath, JSON.stringify(results, null, 2))
    console.log(`\n\n🎉 Crawl complete! Results saved to: ${fullPath}\n`)
  } catch (error) {
    console.error('An unexpected error occurred during the crawl:', error)
    console.error(error.stack)
    if (outputFilePath && Object.keys(results).length > 0) {
      const partialPath = path.resolve(__dirname, `PARTIAL_${outputFilePath}`)
      fs.writeFileSync(partialPath, JSON.stringify(results, null, 2))
      console.log(`\n\n⚠️ Crawl incomplete. Partial results saved to: ${partialPath}\n`)
    }
  } finally {
    if (browser) await browser.close()
  }
}

main()
