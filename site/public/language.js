(() => {
  const STORAGE_KEY = "discode-language";
  const DEFAULT_LANGUAGE = "en";

  const isLanguage = (value) => value === "en" || value === "ko";

  const getStoredLanguage = () => {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return isLanguage(value) ? value : null;
    } catch {
      return null;
    }
  };

  const setStoredLanguage = (language) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {}
  };

  const getDocsPathParts = (pathname) => {
    const hasTrailingSlash = pathname.endsWith("/");
    const segments = pathname.split("/").filter(Boolean);
    const docsIndex = segments.indexOf("docs");
    if (docsIndex === -1) return null;

    let nextIndex = docsIndex + 1;
    const isKorean = segments[nextIndex] === "ko";
    if (isKorean) {
      nextIndex += 1;
    }

    return {
      leadingSegments: segments.slice(0, docsIndex),
      isKorean,
      tailSegments: segments.slice(nextIndex),
      hasTrailingSlash,
    };
  };

  const getPathLanguage = () => {
    const docsPath = getDocsPathParts(window.location.pathname);
    if (!docsPath) return null;
    return docsPath.isKorean ? "ko" : "en";
  };

  const getPathForLanguage = (language) => {
    const docsPath = getDocsPathParts(window.location.pathname);
    if (!docsPath) return window.location.pathname;

    const nextSegments = [...docsPath.leadingSegments, "docs"];
    if (language === "ko") {
      nextSegments.push("ko");
    }
    nextSegments.push(...docsPath.tailSegments);

    let nextPath = `/${nextSegments.join("/")}`;
    if (docsPath.tailSegments.length === 0 && docsPath.hasTrailingSlash) {
      nextPath += "/";
    }

    return nextPath;
  };

  const updateDocsLinks = (language) => {
    const links = document.querySelectorAll("[data-docs-link]");
    links.forEach((link) => {
      const enHref = link.getAttribute("data-href-en");
      const koHref = link.getAttribute("data-href-ko");
      if (!enHref || !koHref) return;
      link.setAttribute("href", language === "ko" ? koHref : enHref);
    });
  };

  const updateLocalizedContent = (language) => {
    const localizedElements = document.querySelectorAll("[data-i18n-en][data-i18n-ko]");
    localizedElements.forEach((element) => {
      const value = element.getAttribute(`data-i18n-${language}`);
      if (value === null) return;

      const attrName = element.getAttribute("data-i18n-attr");
      if (attrName) {
        element.setAttribute(attrName, value);
      } else {
        element.textContent = value;
      }
    });

    document.documentElement.setAttribute("lang", language === "ko" ? "ko" : "en");
  };

  const redirectForLanguage = (language) => {
    const nextPath = getPathForLanguage(language);
    if (nextPath === window.location.pathname) return;
    window.location.replace(`${nextPath}${window.location.search}${window.location.hash}`);
  };

  const selects = Array.from(document.querySelectorAll("[data-language-select]"));
  const storedLanguage = getStoredLanguage();
  const pathLanguage = getPathLanguage();
  const activeLanguage = pathLanguage || storedLanguage || DEFAULT_LANGUAGE;

  selects.forEach((select) => {
    select.value = activeLanguage;
  });
  updateDocsLinks(activeLanguage);
  updateLocalizedContent(activeLanguage);
  setStoredLanguage(activeLanguage);

  if (pathLanguage && storedLanguage && pathLanguage !== storedLanguage) {
    redirectForLanguage(storedLanguage);
    return;
  }

  selects.forEach((select) => {
    select.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      const nextLanguage = target.value;
      if (!isLanguage(nextLanguage)) return;
      setStoredLanguage(nextLanguage);
      selects.forEach((other) => {
        other.value = nextLanguage;
      });
      updateDocsLinks(nextLanguage);
      updateLocalizedContent(nextLanguage);
      if (getPathLanguage()) {
        redirectForLanguage(nextLanguage);
      }
    });
  });
})();
