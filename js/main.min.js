(function (w, d) {

    var body = d.body,
        $ = d.querySelector.bind(d),
        $$ = d.querySelectorAll.bind(d),
        root = $('html'),
        gotop = $('#gotop'),
        menu = $('#menu'),
        header = $('#header'),
        mask = $('#mask'),
        menuToggle = $('#menu-toggle'),
        menuOff = $('#menu-off'),
        loading = $('#loading'),
        animate = w.requestAnimationFrame,
        scrollSpeed = 200 / (1000 / 60),
        forEach = Array.prototype.forEach,
        even = ('ontouchstart' in w && /Mobile|Android|iOS|iPhone|iPad|iPod|Windows Phone|KFAPWI/i.test(navigator.userAgent)) ? 'touchstart' : 'click',
        isWX = /micromessenger/i.test(navigator.userAgent),
        noop = function () { },
        offset = function (el) {
            var x = el.offsetLeft,
                y = el.offsetTop;

            if (el.offsetParent) {
                var pOfs = arguments.callee(el.offsetParent);
                x += pOfs.x;
                y += pOfs.y;
            }

            return {
                x: x,
                y: y
            };
        },
        rootScollTop = function() {
            return d.documentElement.scrollTop || d.body.scrollTop;
        };

    var Blog = {
        goTop: function (end) {
            var top = rootScollTop();
            var interval = arguments.length > 2 ? arguments[1] : Math.abs(top - end) / scrollSpeed;

            if (top && top > end) {
                w.scrollTo(0, Math.max(top - interval, 0));
                animate(arguments.callee.bind(this, end, interval));
            } else if (end && top < end) {
                w.scrollTo(0, Math.min(top + interval, end));
                animate(arguments.callee.bind(this, end, interval));
            } else {
                this.toc.actived(end);
            }
        },
        toggleGotop: function (top) {
            if (top > w.innerHeight / 2) {
                gotop.classList.add('in');
            } else {
                gotop.classList.remove('in');
            }
        },
        toggleMenu: function (flag) {
            var main = $('#main');
            if (flag) {
                menu.classList.remove('hide');

                if (w.innerWidth < 1241) {
                    mask.classList.add('in');
                    menu.classList.add('show');

                    if (isWX) {
                        var top = rootScollTop();
                        main.classList.add('lock');
                        main.scrollTop = top;
                    } else {
                        root.classList.add('lock');
                    }
                }

            } else {
                menu.classList.remove('show');
                mask.classList.remove('in');
                if (isWX) {
                    var top = main.scrollTop;
                    main.classList.remove('lock');
                    w.scrollTo(0, top);
                } else {
                    root.classList.remove('lock');
                }

            }
        },
        fixedHeader: function (top) {
            if (top > header.clientHeight) {
                header.classList.add('fixed');
            } else {
                header.classList.remove('fixed');
            }
        },
        toc: (function () {
            var toc = $('#post-toc');

            if (!toc || !toc.children.length) {
                return {
                    fixed: noop,
                    actived: noop
                }
            }

            var bannerH = $('.post-header').clientHeight,
                headerH = header.clientHeight,
                titles = $('#post-content').querySelectorAll('h1, h2, h3, h4, h5, h6');

            /**
             * Safely find a toc link by heading id, return null if not found
             */
            function tocLink(id) {
                if (!id) return null;
                return toc.querySelector('a[href="#' + id + '"]');
            }

            var firstLink = tocLink(titles[0].id);
            if (firstLink) {
                firstLink.parentNode.classList.add('active');

                var firstChild = firstLink.nextElementSibling;
                if (firstChild) {
                    firstChild.classList.add('post-toc-expand');
                    firstChild.classList.remove('post-toc-shrink');
                }
            }

            // Make every child shrink initially
            var tocChilds = toc.querySelectorAll('.post-toc-child');
            for (i = 0, len = tocChilds.length; i < len; i++) {
                tocChilds[i].classList.add('post-toc-shrink');
            }
            toc.classList.remove('post-toc-shrink');

            /**
             * Handle toc active and expansion
             * @param prevEle previous active li element
             * @param currEle current active li element
             */
            var handleTocActive = function (prevEle, currEle) {
                if (prevEle) prevEle.classList.remove('active');
                if (currEle) currEle.classList.add('active');
                if (!currEle) return;

                var siblingChilds = currEle.parentElement.querySelectorAll('.post-toc-child');
                for (j = 0, len1 = siblingChilds.length; j < len1; j++) {
                    siblingChilds[j].classList.remove('post-toc-expand');
                    siblingChilds[j].classList.add('post-toc-shrink');
                }
                var myChild = currEle.querySelector('.post-toc-child');
                if (myChild) {
                    myChild.classList.remove('post-toc-shrink');
                    myChild.classList.add('post-toc-expand');
                }
            };

            return {
                fixed: function (top) {
                    top >= bannerH - headerH ? toc.classList.add('fixed') : toc.classList.remove('fixed');
                },
                actived: function (top) {
                    for (i = 0, len = titles.length; i < len; i++) {
                        if (top > offset(titles[i]).y - headerH - 5) {
                            var prevListEle = toc.querySelector('li.active');
                            var currLink = tocLink(titles[i].id);
                            if (currLink) {
                                handleTocActive(prevListEle, currLink.parentNode);
                            }
                        }
                    }

                    if (top < offset(titles[0]).y) {
                        var firstLink = tocLink(titles[0].id);
                        if (firstLink) {
                            handleTocActive(
                                toc.querySelector('li.active'),
                                firstLink.parentNode
                            );
                        }
                    }
                }
            }
        })(),
        hideOnMask: [],
        modal: function (target) {
            this.$modal = $(target);
            this.$off = this.$modal.querySelector('.close');

            var _this = this;

            this.show = function () {
                mask.classList.add('in');
                _this.$modal.classList.add('ready');
                setTimeout(function () {
                    _this.$modal.classList.add('in');
                }, 0)
            }

            this.onHide = noop;

            this.hide = function () {
                _this.onHide();
                mask.classList.remove('in');
                _this.$modal.classList.remove('in');
                setTimeout(function () {
                    _this.$modal.classList.remove('ready');
                }, 300)
            }

            this.toggle = function () {
                return _this.$modal.classList.contains('in') ? _this.hide() : _this.show();
            }

            Blog.hideOnMask.push(this.hide);
            this.$off && this.$off.addEventListener(even, this.hide);
        },
        share: function () {

            var pageShare = $('#pageShare'),
                fab = $('#shareFab');

            var shareModal = new this.modal('#globalShare');

            $('#menuShare').addEventListener(even, shareModal.toggle);

            if (fab) {
                fab.addEventListener(even, function () {
                    pageShare.classList.toggle('in')
                }, false)

                d.addEventListener(even, function (e) {
                    !fab.contains(e.target) && pageShare.classList.remove('in')
                }, false)
            }

            var wxModal = new this.modal('#wxShare');
            wxModal.onHide = shareModal.hide;

            forEach.call($$('.wxFab'), function (el) {
                el.addEventListener(even, wxModal.toggle)
            })

        },
        search: function () {
            var searchWrap = $('#search-wrap');

            function toggleSearch() {
                searchWrap.classList.toggle('in');
            }

            $('#search').addEventListener(even, toggleSearch);
        },
        reward: function () {
            var modal = new this.modal('#reward');
            $('#rewardBtn').addEventListener(even, modal.toggle);

            var $rewardToggle = $('#rewardToggle');
            var $rewardCode = $('#rewardCode');
            if ($rewardToggle) {
                $rewardToggle.addEventListener('change', function () {
                    $rewardCode.src = this.checked ? this.dataset.alipay : this.dataset.wechat
                })
            }
        },
        waterfall: function () {

            if (w.innerWidth < 760) return;

            forEach.call($$('.waterfall'), function (el) {
                var childs = el.querySelectorAll('.waterfall-item');
                var columns = [0, 0];

                forEach.call(childs, function (item) {
                    var i = columns[0] <= columns[1] ? 0 : 1;
                    item.style.cssText = 'top:' + columns[i] + 'px;left:' + (i > 0 ? '50%' : 0);
                    columns[i] += item.offsetHeight;
                })

                el.style.height = Math.max(columns[0], columns[1]) + 'px';
                el.classList.add('in')
            })

        },
        tabBar: function (el) {
            el.parentNode.parentNode.classList.toggle('expand')
        },
        smoothTags: function () {
            // 只在标签/分类页面启用
            var tagsBar = $('.tabs-bar');
            if (!tagsBar) return;

            var bodyWrap = $('.body-wrap');
            if (!bodyWrap) return;

            var isLoading = false;

            // 规范化链接：去掉尾部斜杠，方便比较
            function normalize(url) {
                try {
                    var u = new URL(url, w.location.origin);
                    var path = u.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
                    return u.origin + path;
                } catch (err) {
                    return url.replace(/\/index\.html$/, '').replace(/\/$/, '');
                }
            }

            // 统一设置 active 状态：先清空再设置
            function setActiveByUrl(url) {
                var all = tagsBar.querySelectorAll('.tags-list-item');
                var normalizedTarget = normalize(url);
                for (var i = 0; i < all.length; i++) {
                    all[i].classList.remove('active');
                }
                for (var j = 0; j < all.length; j++) {
                    if (normalize(all[j].href) === normalizedTarget) {
                        all[j].classList.add('active');
                        return;
                    }
                }
            }

            // 提取 fetch 切换逻辑为独立函数（同时供桌面和移动端使用）
            function switchToTag(targetUrl, link) {
                if (isLoading) return;
                if (link && link.classList.contains('active')) return;

                e_prevent();
                isLoading = true;

                // 添加加载指示
                loading.classList.add('active');

                // 淡出当前内容
                bodyWrap.classList.remove('in');

                setTimeout(function () {
                    fetch(targetUrl)
                        .then(function (response) {
                            return response.text();
                        })
                        .then(function (html) {
                            // 解析返回的 HTML
                            var parser = new DOMParser();
                            var doc = parser.parseFromString(html, 'text/html');

                            // 获取新的 body-wrap 内容
                            var newBodyWrap = doc.querySelector('.body-wrap');
                            if (newBodyWrap) {
                                bodyWrap.innerHTML = newBodyWrap.innerHTML;
                            }

                            // 立即更新 active 状态
                            setActiveByUrl(targetUrl);

                            // 更新 URL
                            history.pushState({ tagSwitch: true, url: targetUrl }, '', targetUrl);

                            // 更新页面标题
                            var newTitle = doc.querySelector('title');
                            if (newTitle) {
                                document.title = newTitle.textContent;
                            }

                            // 淡入新内容
                            setTimeout(function () {
                                bodyWrap.classList.add('in');
                                loading.classList.remove('active');
                                isLoading = false;

                                // 重新计算瀑布流布局
                                Blog.waterfall();

                                // 滚动到顶部
                                w.scrollTo(0, 0);
                            }, 50);
                        })
                        .catch(function () {
                            // 出错时回退到普通跳转
                            isLoading = false;
                            location.href = targetUrl;
                        });
                }, 300);
            }

            // 简单的阻止默认事件
            function e_prevent() {
                if (window.event) {
                    window.event.preventDefault();
                    window.event.stopPropagation();
                }
            }

            // 用 pointerdown 统一处理桌面和移动端，捕获阶段
            function handlePointer(e) {
                // 排除 PC show more 按钮
                if (e.target.closest && e.target.closest('.tags-list-more')) return;

                // 用 closest 找 a 标签
                var link = e.target.closest ? e.target.closest('a.tags-list-item') : null;
                if (!link || !link.href || isLoading) return;

                // 如果已经是当前页面，不处理
                if (link.classList.contains('active')) return;

                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();

                switchToTag(link.href, link);
            }

            // pointerdown：现代浏览器（桌面+移动）统一入口
            if (w.PointerEvent) {
                tagsBar.addEventListener('pointerdown', handlePointer, true);
            } else {
                // 老浏览器兜底
                tagsBar.addEventListener('mousedown', handlePointer, true);
                tagsBar.addEventListener('touchstart', handlePointer, true);
            }

            // 处理浏览器后退/前进
            w.addEventListener('popstate', function (e) {
                if (e.state && e.state.tagSwitch && e.state.url) {
                    isLoading = true;
                    loading.classList.add('active');
                    bodyWrap.classList.remove('in');

                    setTimeout(function () {
                        fetch(e.state.url)
                            .then(function (r) { return r.text(); })
                            .then(function (html) {
                                var doc = new DOMParser().parseFromString(html, 'text/html');
                                var newBodyWrap = doc.querySelector('.body-wrap');
                                if (newBodyWrap) {
                                    bodyWrap.innerHTML = newBodyWrap.innerHTML;
                                }
                                setActiveByUrl(e.state.url);
                                var newTitle = doc.querySelector('title');
                                if (newTitle) document.title = newTitle.textContent;
                                setTimeout(function () {
                                    bodyWrap.classList.add('in');
                                    loading.classList.remove('active');
                                    isLoading = false;
                                    Blog.waterfall();
                                }, 50);
                            })
                            .catch(function () {
                                location.href = e.state.url;
                            });
                    }, 300);
                }
            });
        },
        page: (function () {
            var $elements = $$('.fade, .fade-scale');
            var visible = false;

            return {
                loaded: function () {
                    forEach.call($elements, function (el) {
                        el.classList.add('in')
                    });
                    visible = true;
                },
                unload: function () {
                    forEach.call($elements, function (el) {
                        el.classList.remove('in')
                    });
                    visible = false;
                },
                visible: visible
            }

        })(),
        lightbox: (function () {

            function LightBox(element) {
                this.$img = element.querySelector('img');
                this.$overlay = element.querySelector('overlay');
                this.margin = 40;
                this.title = this.$img.title || this.$img.alt || '';
                this.isZoom = false;

                var naturalW, naturalH, imgRect, docW, docH;

                this.calcRect = function () {
                    docW = body.clientWidth;
                    docH = body.clientHeight;
                    var inH = docH - this.margin * 2;
                    var w = naturalW;
                    var h = naturalH;
                    var t = this.margin;
                    var l = 0;
                    var sw = w > docW ? docW / w : 1;
                    var sh = h > inH ? inH / h : 1;
                    var s = Math.min(sw, sh);

                    w = w * s;
                    h = h * s;

                    return {
                        w: w,
                        h: h,
                        t: (docH - h) / 2 - imgRect.top,
                        l: (docW - w) / 2 - imgRect.left + this.$img.offsetLeft
                    }
                }

                this.setImgRect = function (rect) {
                    this.$img.style.cssText = 'width: ' + rect.w + 'px; max-width: ' + rect.w + 'px; height:' + rect.h + 'px; top: ' + rect.t + 'px; left: ' + rect.l + 'px';
                }

                this.setFrom = function () {
                    this.setImgRect({
                        w: imgRect.width,
                        h: imgRect.height,
                        t: 0,
                        l: (element.offsetWidth - imgRect.width) / 2
                    })
                }

                this.setTo = function () {
                    this.setImgRect(this.calcRect());
                }

                // this.updateSize = function () {
                //     var sw = sh = 1;
                //     if (docW !== body.clientWidth) {
                //         sw = body.clientWidth / docW;
                //     }

                //     if (docH !== body.clientHeight) {
                //         sh = body.clientHeight / docH;
                //     }

                //     docW = body.clientWidth;
                //     docH = body.clientHeight;
                //     var rect = this.$img.getBoundingClientRect();
                //     var w = rect.width * sw;
                //     var h = rect.height * sh;

                //     this.$img.classList.remove('zoom-in');
                //     this.setImgRect({
                //         w: w,
                //         h: h,
                //         t: this.$img.offsetTop - (h - rect.height) / 2,
                //         l: this.$img.offsetLeft - (w - rect.width) / 2
                //     })
                // }

                this.addTitle = function () {
                    if (!this.title) {
                        return;
                    }
                    this.$caption = d.createElement('div');
                    this.$caption.innerHTML = this.title;
                    this.$caption.className = 'overlay-title';
                    element.appendChild(this.$caption);
                }

                this.removeTitle = function () {
                    this.$caption && element.removeChild(this.$caption)
                }

                var _this = this;

                this.zoomIn = function () {
                    naturalW = this.$img.naturalWidth || this.$img.width;
                    naturalH = this.$img.naturalHeight || this.$img.height;
                    imgRect = this.$img.getBoundingClientRect();
                    element.style.height = imgRect.height + 'px';
                    element.classList.add('ready');
                    this.setFrom();
                    this.addTitle();
                    this.$img.classList.add('zoom-in');

                    setTimeout(function () {
                        element.classList.add('active');
                        _this.setTo();
                        _this.isZoom = true;
                    }, 0);
                }

                this.zoomOut = function () {
                    this.isZoom = false;
                    element.classList.remove('active');
                    this.$img.classList.add('zoom-in');
                    this.setFrom();
                    setTimeout(function () {
                        _this.$img.classList.remove('zoom-in');
                        _this.$img.style.cssText = '';
                        _this.removeTitle();
                        element.classList.remove('ready');
                        element.removeAttribute('style');
                    }, 300);
                }

                element.addEventListener('click', function (e) {
                    _this.isZoom ? _this.zoomOut() : e.target.tagName === 'IMG' && _this.zoomIn()
                })

                d.addEventListener('scroll', function () {
                    _this.isZoom && _this.zoomOut()
                })

                w.addEventListener('resize', function () {
                    // _this.isZoom && _this.updateSize()
                    _this.isZoom && _this.zoomOut()
                })
            }

            forEach.call($$('.img-lightbox'), function (el) {
                new LightBox(el)
            })
        })(),
        loadScript: function (scripts) {
            scripts.forEach(function (src) {
                var s = d.createElement('script');
                s.src = src;
                s.async = true;
                body.appendChild(s);
            })
        }
    };

    w.addEventListener('load', function () {
        loading.classList.remove('active');
        Blog.page.loaded();
        w.lazyScripts && w.lazyScripts.length && Blog.loadScript(w.lazyScripts)
    });

    w.addEventListener('DOMContentLoaded', function () {
        Blog.waterfall();
        Blog.smoothTags();
        var top = rootScollTop();
        Blog.toc.fixed(top);
        Blog.toc.actived(top);
        Blog.page.loaded();
    });

    var ignoreUnload = false;
    var $mailTarget = $('a[href^="mailto"]');
    if($mailTarget) {
        $mailTarget.addEventListener(even, function () {
            ignoreUnload = true;
        });
    }

    w.addEventListener('beforeunload', function (e) {
        if (!ignoreUnload) {
            Blog.page.unload();
        } else {
            ignoreUnload = false;
        }
    });

    w.addEventListener('pageshow', function () {
        // fix OSX safari #162
        !Blog.page.visible && Blog.page.loaded();
    });

    w.addEventListener('resize', function () {
        w.BLOG.even = even = 'ontouchstart' in w ? 'touchstart' : 'click';
        Blog.toggleMenu();
        Blog.waterfall();
    });

    gotop.addEventListener(even, function () {
        animate(Blog.goTop.bind(Blog, 0));
    }, false);

    menuToggle.addEventListener(even, function (e) {
        Blog.toggleMenu(true);
        e.preventDefault();
    }, false);

    menuOff.addEventListener(even, function () {
        menu.classList.add('hide');
    }, false);

    mask.addEventListener(even, function (e) {
        Blog.toggleMenu();
        Blog.hideOnMask.forEach(function (hide) {
            hide()
        });
        e.preventDefault();
    }, false);

    d.addEventListener('scroll', function () {
        var top = rootScollTop();
        Blog.toggleGotop(top);
        Blog.fixedHeader(top);
        Blog.toc.fixed(top);
        Blog.toc.actived(top);
    }, false);

    if (w.BLOG.SHARE) {
        Blog.share()
    }

    if (w.BLOG.REWARD) {
        Blog.reward()
    }

    Blog.noop = noop;
    Blog.even = even;
    Blog.$ = $;
    Blog.$$ = $$;

    Object.keys(Blog).reduce(function (g, e) {
        g[e] = Blog[e];
        return g
    }, w.BLOG);

    if (w.Waves) {
        Waves.init();
        Waves.attach('.global-share li', ['waves-block']);
        Waves.attach('.article-tag-list-link, #page-nav a, #page-nav span', ['waves-button']);
    } else {
        console.error('Waves loading failed.')
    }
})(window, document);
