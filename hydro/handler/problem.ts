import paginate from '../lib/paginate';
import * as validator from '../lib/validator';
import * as file from '../model/file';
import * as problem from '../model/problem';
import * as record from '../model/record';
import * as user from '../model/user';
import * as solution from '../model/solution';
import * as system from '../model/system';
import { PERM, PRIV } from '../model/builtin';
import * as bus from '../service/bus';
import {
    Route, Connection, Handler, ConnectionHandler,
} from '../service/server';
import {
    NoProblemError, ProblemDataNotFoundError, BadRequestError,
    SolutionNotFoundError,
} from '../error';

class ProblemHandler extends Handler {
    async __prepare() {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM);
    }

    async get({ domainId, page = 1, q = '' }) {
        this.response.template = 'problem_main.html';
        const query: any = {};
        let psdict = {};
        const path: any = [
            ['Hydro', 'homepage'],
            ['problem_main', null],
        ];
        if (q) {
            q = q.toLowerCase();
            const $regex = new RegExp(`\\A\\Q${q}\\E`, 'gmi');
            query.title = { $regex };
            path.push([q, null, null, true]);
        }
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) query.hidden = false;
        const [pdocs, ppcount, pcount] = await paginate(
            problem.getMulti(domainId, query).sort({ pid: 1 }),
            page,
            await system.get('PROBLEM_PER_PAGE'),
        );
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            psdict = await problem.getListStatus(
                domainId, this.user._id, pdocs.map((pdoc) => pdoc.docId),
            );
        }
        this.response.body = {
            path, page, pcount, ppcount, pdocs, psdict, category: q,
        };
    }

    async postStar({ domainId, pid }) {
        await problem.setStar(domainId, pid, this.user._id, true);
        this.back({ star: true });
    }

    async postUnstar({ domainId, pid }) {
        await problem.setStar(domainId, pid, this.user._id, false);
        this.back({ star: false });
    }

    async cleanup() {
        if (this.response.template === 'problem_main.html' && this.request.json) {
            const {
                path, page, pcount, ppcount, pdocs, psdict, category,
            } = this.response.body;
            this.response.body = {
                title: this.renderTitle(category),
                fragments: (await Promise.all([
                    this.renderHTML('partials/problem_list.html', {
                        page, ppcount, pcount, pdocs, psdict,
                    }),
                    this.renderHTML('partials/problem_stat.html', { pcount }),
                    this.renderHTML('partials/problem_lucky.html', { category }),
                    this.renderHTML('partials/path.html', { path }),
                ])).map((i) => ({ html: i })),
                raw: {
                    path, page, pcount, ppcount, pdocs, psdict, category,
                },
            };
        }
    }
}

class ProblemCategoryHandler extends ProblemHandler {
    async get({ domainId, page = 1, category }) {
        this.response.template = 'problem_main.html';
        const q: any = { $and: [] };
        for (const name of category) {
            q.$and.push({
                $or: [
                    { category: { $elemMatch: { $eq: name } } },
                    { tag: { $elemMatch: { $eq: name } } },
                ],
            });
        }
        let psdict = {};
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) q.hidden = false;
        const [pdocs, ppcount, pcount] = await paginate(
            problem.getMulti(domainId, q).sort({ pid: 1 }),
            page,
            await system.get('PROBLEM_PER_PAGE'),
        );
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            psdict = await problem.getListStatus(
                domainId, this.user._id, pdocs.map((pdoc) => pdoc.docId),
            );
        }
        const path = [
            ['Hydro', 'homepage'],
            ['problem_main', 'problem_main'],
            [category, null, null, true],
        ];
        this.response.body = {
            path, page, pcount, ppcount, pdocs, psdict, category: category.join('+'),
        };
    }
}

class ProblemRandomHandler extends ProblemHandler {
    async get({ domainId, category }) {
        const q: any = category[0] ? { $and: [] } : {};
        for (const name of category) {
            if (name) {
                q.$and.push({
                    $or: [
                        { category: { $elemMatch: { $eq: name } } },
                        { tag: { $elemMatch: { $eq: name } } },
                    ],
                });
            }
        }
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) q.hidden = false;
        const pid = await problem.random(domainId, q);
        if (!pid) throw new NoProblemError();
        this.response.body = { pid };
        this.response.redirect = this.url('problem_detail', { pid });
    }
}

class ProblemDetailHandler extends ProblemHandler {
    async _prepare({ domainId, pid }) {
        this.response.template = 'problem_detail.html';
        if (pid) {
            this.pdoc = await problem.get(domainId, pid, this.user._id);
            if (this.pdoc.hidden && this.pdoc.owner !== this.user._id) {
                this.checkPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
            }
            if (this.pdoc) this.udoc = await user.getById(domainId, this.pdoc.owner);
        }
        this.response.body = {
            pdoc: this.pdoc,
            udoc: this.udoc,
            title: (this.pdoc || {}).title || '',
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async get(args: any) {
        this.response.body.path = [
            ['Hydro', 'homepage'],
            ['problem_main', 'problem_main'],
            [this.pdoc.title, null, true],
        ];
    }
}

class ProblemSubmitHandler extends ProblemDetailHandler {
    async get({ domainId, pid }) {
        this.response.template = 'problem_submit.html';
        const rdocs = await record.getUserInProblemMulti(domainId, this.user._id, this.pdoc.docId)
            .sort({ _id: -1 })
            .limit(10)
            .toArray();
        this.response.body = {
            path: [
                ['Hydro', 'homepage'],
                ['problem_main', 'problem_main'],
                [this.pdoc.title, 'problem_detail', { pid }, true],
                ['problem_submit', null],
            ],
            pdoc: this.pdoc,
            udoc: this.udoc,
            rdocs,
            title: this.pdoc.title,
        };
    }

    async post({ domainId }) {
        const { lang, code } = this.request.body;
        const rid = await record.add(domainId, {
            uid: this.user._id, lang, code, pid: this.pdoc.docId,
        }, true);
        await user.incDomain(domainId, this.user._id, 'nSubmit');
        this.response.body = { rid };
        this.response.redirect = this.url('record_detail', { rid });
    }
}

class ProblemPretestHandler extends ProblemDetailHandler {
    async post({
        domainId, lang, code, input,
    }) {
        this.limitRate('add_record', 60, 100);
        const rid = await record.add(domainId, {
            uid: this.user._id, lang, code, pid: this.pdoc.docId, input,
        });
        await record.judge(domainId, rid);
        this.response.body = { rid };
    }
}

class ProblemPretestConnectionHandler extends ConnectionHandler {
    async prepare({ domainId, pid }) {
        this.pid = pid.toString();
        this.domainId = domainId;
        bus.subscribe(['record_change'], this, 'onRecordChange');
    }

    async onRecordChange(data) {
        const rdoc = data.value;
        if (
            rdoc.uid !== this.user._id
            || rdoc.pid.toString() !== this.pid
            || rdoc.domainId !== this.domainId
        ) return;
        if (rdoc.tid) return;
        this.send({ rdoc });
    }

    async cleanup() {
        bus.unsubscribe(['record_change'], this, 'onRecordChange');
    }
}

class ProblemStatisticsHandler extends ProblemDetailHandler {
    async get({ domainId }) {
        const udoc = await user.getById(domainId, this.pdoc.owner);
        const path = [
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid: this.pdoc.pid }, true],
            ['problem_statistics', null],
        ];
        this.response.template = 'problem_statistics.html';
        this.response.body = { pdoc: this.pdoc, udoc, path };
    }
}

class ProblemManageHandler extends ProblemDetailHandler {
    async prepare() {
        if (this.pdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
        else this.checkPerm(PERM.PERM_EDIT_PROBLEM_SELF);
    }
}

class ProblemSettingsHandler extends ProblemManageHandler {
    async get({ pid }) {
        this.response.template = 'problem_settings.html';
        this.response.body.path = [
            ['Hydro', 'homepage'],
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid }, true],
            ['problem_settings', null],
        ];
    }

    async postConfig({ domainId, pid, yaml }) {
        await problem.edit(domainId, pid, { config: yaml });
        this.back();
    }

    async postSetting({
        domainId, pid, hidden = false, category, tag,
    }) {
        await problem.edit(domainId, pid, { hidden, category, tag });
        this.back();
    }
}

class ProblemEditHandler extends ProblemManageHandler {
    async get({ pid }) {
        this.response.template = 'problem_edit.html';
        this.response.body.path = [
            ['Hydro', 'homepage'],
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid }, true],
            ['problem_edit', null],
        ];
        this.response.body.page_name = 'problem_edit';
    }

    async post({ domainId, title, content }) {
        const pid = validator.checkPid(this.request.body.pid);
        const pdoc = await problem.get(domainId, this.request.params.pid);
        await problem.edit(domainId, pdoc.docId, { title, content, pid });
        this.back();
    }
}

class ProblemDataUploadHandler extends ProblemManageHandler {
    async prepare() {
        this.response.template = 'problem_upload.html';
    }

    async get() {
        if (this.pdoc.data && typeof this.pdoc.data === 'object') {
            const f = await file.getMeta(this.pdoc.data);
            this.md5 = f.md5;
        }
        this.response.body.md5 = this.md5;
    }

    async post({ domainId }) {
        if (!this.request.files.file) throw new BadRequestError();
        await problem.setTestdata(domainId, this.pdoc.docId, this.request.files.file.path);
        if (this.pdoc.data && typeof this.pdoc.data === 'object') {
            const f = await file.getMeta(this.pdoc.data);
            this.md5 = f.md5;
        }
        this.response.body.md5 = this.md5;
    }
}

class ProblemDataDownloadHandler extends ProblemDetailHandler {
    async get({ pid }) {
        if (!this.user.hasPriv(PRIV.PRIV_JUDGE)) {
            if (this.user._id !== this.pdoc.owner) {
                this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
            } else this.checkPerm(PERM.PERM_READ_PROBLEM_DATA_SELF);
        }
        if (!this.pdoc.data) throw new ProblemDataNotFoundError(pid);
        else if (typeof this.pdoc.data === 'string') [, this.response.redirect] = this.pdoc.data.split('from:');
        this.response.redirect = await file.url(this.pdoc.data, `${this.pdoc.title}.zip`);
    }
}

class ProblemSolutionHandler extends ProblemDetailHandler {
    async get({ domainId, page = 1 }) {
        this.response.template = 'problem_solution.html';
        this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const [psdocs, pcount, pscount] = await paginate(
            solution.getMulti(domainId, this.pdoc.docId),
            page,
            await system.get('SOLUTION_PER_PAGE'),
        );
        const uids = [this.pdoc.owner];
        const docids = [];
        for (const psdoc of psdocs) {
            docids.push(psdoc.docId);
            uids.push(psdoc.owner);
            if (psdoc.reply.length) {
                for (const psrdoc of psdoc.reply) uids.push(psrdoc.owner);
            }
        }
        const udict = await user.getList(domainId, uids);
        const pssdict = solution.getListStatus(domainId, docids, this.user._id);
        const path = [
            ['problem_main', 'problem_main'],
            [this.pdoc.title, 'problem_detail', { pid: this.pdoc.pid }, true],
            ['problem_solution', null],
        ];
        this.response.body = {
            path, psdocs, page, pcount, pscount, udict, pssdict, pdoc: this.pdoc,
        };
    }

    async post({ domainId, psid }) {
        if (psid) this.psdoc = await solution.get(domainId, psid);
    }

    async postSubmit({ domainId, content }) {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM_SOLUTION);
        await solution.add(domainId, this.pdoc.docId, this.user._id, content);
        this.back();
    }

    async postEditSolution({ domainId, content }) {
        if (this.psdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_SELF);
        this.psdoc = await solution.edit(domainId, this.psdoc.docId, content);
        this.ctx.body.psdoc = this.psdoc;
        this.back();
    }

    async postDeleteSolution({ domainId }) {
        if (this.psdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_SELF);
        await solution.del(domainId, this.psdoc.docId);
        this.back();
    }

    async postReply({ domainId, psid, content }) {
        this.checkPerm(PERM.PERM_REPLY_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        await solution.reply(domainId, psdoc.docId, this.user._id, content);
        this.back();
    }

    async postEditReply({
        domainId, content, psid, psrid,
    }) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if ((!psdoc) || psdoc.pid !== this.pdoc.docId) throw new SolutionNotFoundError(psid);
        if (!(psdoc.owner === this.user._id
            && this.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF_SOLUTION))) {
            if (!(psrdoc.owner === this.user._id
                && this.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF))) {
                this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY);
            }
        }
        await solution.editReply(domainId, psid, psrid, content);
        this.back();
    }

    async postDeleteReply({ domainId, psid, psrid }) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if ((!psdoc) || psdoc.pid !== this.pdoc.docId) throw new SolutionNotFoundError(psid);
        if (!(psdoc.owner === this.user._id
            && this.user.hasPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF_SOLUTION))) {
            if (!(psrdoc.owner === this.user._id
                && this.user.hasPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF))) {
                this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY);
            }
        }
        await solution.delReply(domainId, psid, psrid);
        this.back();
    }

    async postUpvote({ domainId }) {
        const [psdoc, pssdoc] = await solution.vote(domainId, this.psdoc.docId, this.user._id, 1);
        this.response.body = { vote: psdoc.vote, user_vote: pssdoc.vote };
        this.back();
    }

    async postDownvote({ domainId }) {
        const [psdoc, pssdoc] = await solution.vote(domainId, this.psdoc.docId, this.user._id, -1);
        this.response.body = { vote: psdoc.vote, user_vote: pssdoc.vote };
        this.back();
    }
}

class ProblemSolutionRawHandler extends ProblemDetailHandler {
    async get({ domainId, psid }) {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        this.response.type = 'text/markdown';
        this.response.body = psdoc.content;
    }
}

class ProblemSolutionReplyRawHandler extends ProblemDetailHandler {
    async get({ domainId, psid, psrid }) {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if ((!psdoc) || psdoc.pid !== this.pdoc.docId) throw new SolutionNotFoundError(psid, psrid);
        this.response.type = 'text/markdown';
        this.response.body = psrdoc.content;
    }
}

class ProblemCreateHandler extends Handler {
    async get() {
        this.response.template = 'problem_edit.html';
        this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        this.response.body = {
            path: [
                ['Hydro', 'homepage'],
                ['problem_main', 'problem_main'],
                ['problem_create', null],
            ],
            page_name: 'problem_create',
        };
    }

    async post({
        domainId, title, pid, content, hidden,
    }) {
        pid = await problem.add(domainId, title, content, this.user._id, {
            pid, hidden,
        });
        this.response.body = { pid };
        this.response.redirect = this.url('problem_settings', { pid });
    }
}

export async function apply() {
    Route('problem_main', '/p', ProblemHandler);
    Route('problem_category', '/p/category/:category', ProblemCategoryHandler);
    Route('problem_random', '/problem/random', ProblemRandomHandler);
    Route('problem_detail', '/p/:pid', ProblemDetailHandler);
    Route('problem_submit', '/p/:pid/submit', ProblemSubmitHandler, PERM.PERM_SUBMIT_PROBLEM);
    Route('problem_pretest', '/p/:pid/pretest', ProblemPretestHandler);
    Route('problem_settings', '/p/:pid/settings', ProblemSettingsHandler);
    Route('problem_statistics', '/p/:pid/statistics', ProblemStatisticsHandler);
    Route('problem_edit', '/p/:pid/edit', ProblemEditHandler);
    Route('problem_upload', '/p/:pid/upload', ProblemDataUploadHandler);
    Route('problem_data', '/p/:pid/data', ProblemDataDownloadHandler);
    Route('problem_solution', '/p/:pid/solution', ProblemSolutionHandler);
    Route('problem_solution_raw', '/p/:pid/solution/:psid/raw', ProblemSolutionRawHandler);
    Route('problem_solution_reply_raw', '/p/:pid/solution/:psid/:psrid/raw', ProblemSolutionReplyRawHandler);
    Route('problem_create', '/problem/create', ProblemCreateHandler);
    Connection('problem_pretest_conn', '/p/:pid/pretest-conn', ProblemPretestConnectionHandler);
}

global.Hydro.handler.problem = apply;