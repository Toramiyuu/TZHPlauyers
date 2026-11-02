/*
 * i18n.js — English / Simplified Chinese for the PLAYER-FACING screens.
 *
 * The app writes English straight into its markup and templates, so rather
 * than threading t() through thousands of lines this swaps text in the DOM:
 * every text node (and placeholder / title / aria-label) inside a player-facing
 * root is looked up in ZH, then in PATTERNS for text with numbers, dates or
 * names in it. A MutationObserver keeps it up as the 2s poll re-renders.
 *
 * The admin panel is deliberately left in English: nothing outside ROOTS is
 * touched, and the toast (#notif) only while the admin panel is closed.
 * Each node remembers its English, so switching back restores it exactly.
 */
(function () {
  'use strict';
  const KEY = 'tzhLang';
  let lang = 'en';
  try { lang = localStorage.getItem(KEY) === 'zh' ? 'zh' : 'en'; } catch (e) {}

  const ROOTS = ['#viewer', '#friendlyViewer', '#soonModal', '#lbModal', '#drawPage', '#drawVideoModal',
    '#pickerOverlay', '#siteGate', '#membersModal', '#historyModal', '#authModal', '#statusModal',
    '#accountModal', '#myDrawModal', '#changePwModal', '#profileModal', '#joinModal', '#koModal',
    '#koBracketModal', '#accountWidget', '#notif'];
  const ROOT_SEL = ROOTS.join(',');
  const SKIP_SEL = 'script,style,textarea,select,option,code,[data-no-i18n],.lang-toggle';
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  const ZH = {
    // ── viewer ──
    'Live': '实时', 'Coming soon': '即将开始', 'Members': '会员', 'Lucky Draw': '幸运抽奖',
    'Leaderboard': '排行榜', 'Join social games': '报名打球', 'Competition': '比赛', '3D View': '3D 视图',
    'Sign in': '登录', 'Slots': '名额', 'Open': '开放', 'Full': '已满', 'Level': '水平',
    'Join this session': '报名这一场', 'TZH Badminton | Live Court Display': 'TZH Badminton | 实时球场看板',
    'Members Only': '仅限会员', 'Switch to the 3D arena view (best on desktop)': '切换到 3D 球馆视图（电脑上效果最佳）',
    'Next session': '下一场', 'Close': '关闭', 'Up Next': '下一局', 'Nothing queued yet': '还没有排好的球局',
    'Ending Soon': '即将结束', 'vs': '对', 'No session scheduled yet': '还没有安排场次',
    'No session scheduled': '还没有安排场次', 'Check back soon for the next social game.': '请稍后再来看下一场社交球局。',
    'Final': '终局', 'Games won': '胜局', 'TBD': '待定', 'Red Team': '红队', 'Blue Team': '蓝队',
    'All square': '平手', 'No court matchups set yet.': '还没有安排对阵。', 'No players assigned yet.': '还没有安排球员。',
    // ── tiers / leaderboard / members ──
    'Bronze': '铜级', 'Silver': '银级', 'Gold': '金级', 'Platinum': '白金级', 'Visitor': '访客',
    'Close leaderboard': '关闭排行榜', 'Membership Tier System': '会员等级制度', 'POINTS': '积分',
    'Start earning points with every purchase': '每次消费都能赚积分', 'Upgrade to Bronze at': '升级铜级需',
    'Quarterly Bronze Lucky Draw': '铜级季度幸运抽奖', 'Points Redemption Program': '积分兑换计划',
    'Member Exclusive Promotions': '会员专属优惠', 'All Bronze Benefits': '享有全部铜级福利',
    'Free Grip With Every Stringing': '每次穿线送手胶', 'Quarterly Silver Lucky Draw': '银级季度幸运抽奖',
    'Most Popular': '最受欢迎', 'All Silver Benefits': '享有全部银级福利', 'RM5 Stringing Discount': '穿线优惠 RM5',
    'Quarterly Gold Lucky Draw': '金级季度幸运抽奖', 'All Gold Benefits': '享有全部金级福利',
    'RM10 Stringing Discount': '穿线优惠 RM10', 'Quarterly Platinum Lucky Draw': '白金级季度幸运抽奖',
    'All Platinum Benefits': '享有全部白金级福利', 'Highest Stringing Privileges': '最高穿线特权',
    'Exclusive VIP Rewards': 'VIP 专属奖励', 'Quarterly VIP Lucky Draw': 'VIP 季度幸运抽奖',
    'How to Earn Points?': '如何赚取积分？', 'Shuttlecock': '羽毛球', 'Purchase': '购买', 'Stringing': '穿线',
    'Service': '服务', 'Sports': '运动', 'Products': '用品', 'Coaching': '教练', 'Programs': '课程',
    'Badminton': '羽毛球', 'Sessions': '球局', '= 1 POINT': '= 1 积分', 'Member Benefits Overview': '会员福利一览',
    'Benefits': '福利', 'Quarterly Lucky Draw': '季度幸运抽奖', 'Stringing Discount': '穿线优惠', 'BEST': '最佳',
    'Higher Stringing Privileges': '更高穿线特权', 'Exclusive Rewards': '专属奖励',
    'The more you play, the more you earn. Thank you for being part of the TZH Sports Club family.':
      '打得越多，赚得越多。感谢你成为 TZH Sports Club 大家庭的一员。',
    'Close members': '关闭会员', 'Session History': '场次记录', 'Close history': '关闭记录',
    // ── lock screen ──
    'Tap to pick your dates': '点击选择日期', 'Members · enter access code': '会员 · 输入通行码',
    'Incorrect code. Try again.': '通行码错误，请再试一次。', 'Enter': '进入',
    'Members only · Authorised access': '仅限会员 · 授权访问', 'Admin access': '管理员入口',
    'Want to join our social games? Open the sign-up': '想加入我们的社交球局？打开报名',
    // ── lucky draw ──
    'All draws': '全部抽奖', 'Session': '场次', 'Monthly': '月度', 'How it works': '玩法说明', 'Record': '记录',
    'Loading…': '加载中…', 'Show older sessions': '显示更早的场次', 'Choose a draw': '选择抽奖',
    'Close Lucky Draw': '关闭幸运抽奖', 'Session Draw': '场次抽奖', 'Monthly Draw': '月度抽奖',
    'Lucky Draw replay': '幸运抽奖回放', 'Play again': '再播一次', 'Share': '分享', 'Download video': '下载视频',
    'Close replay': '关闭回放', 'Lucky Draw replay video': '幸运抽奖回放视频', 'Close draw': '关闭抽奖',
    'Court display': '球场看板', 'Two draws run here. Open one to see how to get in and who has won.':
      '这里有两种抽奖。点开查看如何参加和谁中奖了。',
    'Next draw': '下次抽奖', 'to go': '后开奖', 'until the draw': '后开奖', 'any moment now': '马上开奖',
    'Play and pay a session': '打一场并付款', '1st': '第一名', '2nd': '第二名', '3rd': '第三名',
    '1st place': '第一名', '2nd place': '第二名', '3rd place': '第三名', 'Last:': '上次：',
    'Open Session Draw': '打开场次抽奖', 'Open Monthly Draw': '打开月度抽奖',
    'Signed in members see whether they are in each draw.': '登录的会员可以看到自己是否参加了每个抽奖。',
    'Back to the court display': '返回球场看板', 'Sign in to see if you’re in ›': '登录查看你是否入选 ›',
    'Winners get': '得奖者可获得', 'Tap the arrow or a dot for the next prize': '点击箭头或圆点查看下一个奖品',
    'Drawn': '已开奖', 'Draw pending': '待开奖', 'Quick draw': '快速抽奖', 'Pending': '待定',
    'Manual quick draw': '手动快速抽奖', 'Automatic draw': '自动抽奖', 'verified ✓': '已验证 ✓',
    'Next prize': '下一个奖品', 'Random seed: the full order can be replayed from it': '随机种子：可用它重现完整抽奖顺序',
    'This month’s prizes': '本月奖品', 'This month': '本月', 'Previous year': '上一年', 'Next year': '下一年',
    'Play replay': '播放回放', 'drawn': '已开奖', 'no draw': '无抽奖', 'draw pending': '待开奖',
    'quick draw': '快速抽奖', 'this month': '本月', 'Open the Lucky Draw page': '打开幸运抽奖页面',
    // ── sign in / accounts ──
    'Welcome back': '欢迎回来',
    'Type the login code the organiser gave you to see your points, payments and draw wins.':
      '输入组织者给你的登录码，查看你的积分、付款和中奖记录。',
    'Don’t have a code?': '没有登录码？', 'Use phone number & password instead': '改用手机号和密码',
    'Sign in with your phone number.': '用手机号登录。', 'Sign in with a login code instead': '改用登录码登录',
    'Forgot password?': '忘记密码？', 'Request an account': '申请账户', 'My status': '我的申请状态',
    'Request a TZH account. An administrator will review and approve it.': '申请 TZH 账户，管理员审核后批准。',
    'Submit request': '提交申请', 'Have an account? Sign in': '已有账户？登录',
    'Check your account request. Enter the phone number and password you used.': '查看你的账户申请。请输入你申请时用的手机号和密码。',
    'Check status': '查看状态', 'Back to sign in': '返回登录', 'e.g. Thomas#123': '例如 Thomas#123',
    'Phone number (e.g. 012-345 6789)': '手机号（例如 012-345 6789）', 'Password': '密码',
    'Your name (helps us match you)': '你的名字（方便我们核对）', 'Phone number': '手机号',
    'Choose a password (6+ characters)': '设置密码（至少 6 个字符）', 'Confirm password': '确认密码',
    'Don’t have a login code?': '没有登录码？',
    'Ask the TZH organiser at your next session. Every member has a code like Thomas#123. Codes are handed out in person, not by SMS, WhatsApp or email.':
      '下次打球时向 TZH 组织者索取。每位会员都有一个像 Thomas#123 这样的登录码。登录码只当面发放，不会通过短信、WhatsApp 或电邮发送。',
    'Please contact the TZH administrator for help with your password. The administrator can look up your account by phone number and give you a temporary password to sign in with.':
      '请联系 TZH 管理员协助处理密码问题。管理员可以用手机号查找你的账户，并给你一个临时密码登录。',
    'Contact the administrator': '联系管理员', 'Contact administrator': '联系管理员',
    'Please contact the TZH administrator for help with your account or password. For your security, approvals and passwords are handled in person, not by SMS, WhatsApp or email.':
      '如需账户或密码方面的协助，请联系 TZH 管理员。为了你的安全，审核和密码只当面处理，不会通过短信、WhatsApp 或电邮。',
    'Continue': '继续', 'Pending Approval': '等待审核',
    'Your account request has been submitted and is waiting for administrator approval.': '你的账户申请已提交，正在等待管理员审核。',
    'Request date': '申请日期', 'Status': '状态', 'Last update': '最后更新', 'Refresh status': '刷新状态',
    'Rejected': '未通过', 'Your account request was not approved.': '你的账户申请没有通过。', 'Update & resubmit': '修改并重新提交',
    // ── My TZH ──
    'My TZH': '我的 TZH', 'My Lucky Draw': '我的幸运抽奖', 'Change password': '更改密码',
    'Enter your current password and a new one.': '输入当前密码和新密码。', 'Cancel': '取消',
    'Save password': '保存密码', 'Current password': '当前密码', 'New password (6+ characters)': '新密码（至少 6 个字符）',
    'Confirm new password': '确认新密码', 'Your profile': '你的资料', 'Tap photo to change': '点击照片更换',
    'Save changes': '保存更改', 'Display name': '显示名称', 'My points & payments': '我的积分和付款',
    'Edit profile': '编辑资料', 'Log out': '登出', 'Login code': '登录码', 'Points': '积分',
    'Nothing owing': '没有欠款', 'Draw wins': '中奖次数', 'Draw win': '中奖次数',
    'Your latest session. How was it? Tap whatever fits — it only goes to the organiser.':
      '你最近的一场打得怎么样？点选符合的项目，只有组织者会看到。',
    'What went well': '哪些不错', 'Games were at a good level': '球局水平合适',
    'Didn’t wait long between games': '每局之间不用等太久', 'Well-balanced partners': '搭档实力均衡',
    'Good mix of opponents': '对手搭配多样', 'What could be better': '哪些可以改进',
    'Kept partnering the same people': '老是和同样的人搭档', 'Kept playing the same opponents': '老是遇到同样的对手',
    'Didn’t get to play stronger opponents': '没机会和更强的对手打', 'Waited too long between games': '每局之间等太久',
    'Send feedback': '提交反馈', 'My draw wins': '我的中奖记录',
    'No prizes yet. Every paid session is a ticket to the next draw.': '还没有中奖。每付款一场就多一次参加下次抽奖的机会。',
    'Paid history': '付款记录', 'Paid': '已付款', 'Unpaid': '未付款', 'Cash': '现金', 'Present': '出席',
    'Eligible': '符合资格', 'Not eligible': '不符合资格', 'Anything else that was good?': '还有其他好的地方吗？',
    'Anything else we should fix?': '还有什么需要改进的？', 'Monthly draw': '月度抽奖',
    'Points this month': '本月积分', 'My recent sessions': '我最近的场次', 'Signed in!': '已登录！',
    'In the Monthly draw ✓': '已入选月度抽奖 ✓',
    // ── sign-up / tournament ──
    'Join our social games': '加入我们的社交球局', 'Pick the dates you\'d like to play.': '选择你想打球的日期。',
    'Open game days': '开放的打球日', 'Select one or more dates to continue.': '选择一个或多个日期以继续。',
    'Add another person': '再加一个人', 'Dates for everyone': '所有人的日期',
    'Thanks! We\'ve got your details and will be in touch about our social games.': '谢谢！我们已收到你的资料，会再联系你关于社交球局的安排。',
    'Back': '返回', 'Next': '下一步', 'Previous month': '上个月', 'Next month': '下个月',
    'Tournament entry': '比赛报名', 'Enter the code from the poster.': '输入海报上的代码。', 'Category code': '组别代码',
    'Each category has its own code. You will find it on the poster or the post you came from.': '每个组别都有自己的代码，可在海报或你看到的帖子上找到。',
    'Add participants': '添加参赛者', 'You': '你', 'Name': '名字', 'Skill level': '球技水平',
    'Beginner': '初级', 'Intermediate': '中级', 'Advanced': '高级',
    // ── errors ──
    'Enter a display name.': '请输入显示名称。', 'Enter a valid Malaysian phone number.': '请输入有效的马来西亚手机号。',
    'Enter your login code.': '请输入你的登录码。', 'Enter your phone number and password.': '请输入手机号和密码。',
    'Enter your phone number.': '请输入手机号。', 'New password must be at least 6 characters.': '新密码至少要 6 个字符。',
    'Password must be at least 6 characters.': '密码至少要 6 个字符。', 'Passwords do not match.': '两次输入的密码不一致。',
    'Could not sign in.': '登录失败。', 'Account not active.': '账户未启用。', 'Account not found.': '找不到账户。',
    'Current password is incorrect.': '当前密码不正确。', 'Phone number or password is incorrect.': '手机号或密码不正确。',
    'Session expired.': '登录已过期。', 'That login code isn’t right. Check it with the organiser.': '登录码不正确，请向组织者确认。',
    'Enter your login code, e.g. Thomas#123.': '请输入你的登录码，例如 Thomas#123。',
    'Login codes look like Name#123 — letters, then # and 3 to 6 digits.': '登录码格式像 Name#123：字母，加 #，再加 3 到 6 位数字。',
    'An account already exists for that phone number.': '这个手机号已经有账户了。',
    'An account request already exists for this phone number.': '这个手机号已经提交过账户申请。',
    'No account found for that phone number, or no password set. Contact the administrator.': '找不到这个手机号的账户，或还没设置密码。请联系管理员。',
    'Account limit reached. Please contact the administrator.': '账户数量已达上限，请联系管理员。',
    'Image is too large.': '图片太大。', 'Invalid image.': '图片无效。', 'Please enter a name.': '请输入名字。',
  };

  // Words that only mean one thing in one place.
  const SCOPED = {
    '#siteGate': { 'Want': '想加入', 'to': '', 'join': '', 'our': '我们的', 'social games?': '社交球局吗？' },
    '#drawPage': { 'in': '还有' },
  };

  const WD = { Monday: '星期一', Tuesday: '星期二', Wednesday: '星期三', Thursday: '星期四', Friday: '星期五', Saturday: '星期六', Sunday: '星期日' };
  const WDS = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };
  const WD1 = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' };
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONS = MON.map(m => m.slice(0, 3));
  const mNum = m => (MON.indexOf(m) + 1) || (MONS.indexOf(m) + 1);
  const WDRE = Object.keys(WD).join('|'), WDSRE = Object.keys(WDS).join('|');
  const MRE = MON.join('|'), MSRE = MONS.join('|');
  const time = (h, mm, ap) => (ap.toUpperCase() === 'AM' ? '上午' : '下午') + h + ':' + mm;
  const days = list => {
    const ds = list.split(/, | & | and /).map(d => WD[d.replace(/s$/, '')] || null);
    if (ds.some(d => !d)) return null;
    return ds.length > 1 ? ds.slice(0, -1).join('、') + '和' + ds[ds.length - 1] : ds[0];
  };
  const sched = s => s.replace(new RegExp('\\b(' + WDSRE + ')\\b', 'g'), d => WDS[d]).replace(/, /g, '，');

  // Each pattern returns the Chinese, or null to fall through. `t` translates a
  // sub-part (null when it cannot), so dates and counts compose.
  const PATTERNS = [
    [new RegExp('^(' + WDRE + ') (\\d{1,2}) (' + MRE + ') (\\d{4})$'), (m) => `${m[4]}年${mNum(m[3])}月${m[2]}日 ${WD[m[1]]}`],
    [new RegExp('^(\\d{1,2}) (' + MRE + ') (\\d{4})$'), (m) => `${m[3]}年${mNum(m[2])}月${m[1]}日`],
    [new RegExp('^(' + MRE + ') (\\d{4})$'), (m) => `${m[2]}年${mNum(m[1])}月`],
    [new RegExp('^(' + MRE + ')$'), (m) => `${mNum(m[1])}月`],
    [new RegExp('^(' + MSRE + ')$'), (m) => `${mNum(m[1])}月`],
    [new RegExp('^(' + WDRE + ')$'), (m) => WD[m[1]]],
    [new RegExp('^(' + WDSRE + ')$'), (m) => WD1[m[1]]],
    [new RegExp('^(' + WDSRE + ') (\\d{1,2}) (' + MSRE + ')(?: (\\d{4}))?$'), (m) => `${m[4] ? m[4] + '年' : ''}${mNum(m[3])}月${m[2]}日 ${WDS[m[1]]}`],
    [new RegExp('^(' + WDRE + ') (\\d{1,2}/\\d{1,2}/\\d{2})$'), (m) => `${m[2]} ${WD[m[1]]}`],
    [/^(\d{1,2}):(\d{2}) ?(AM|PM|am|pm)$/, (m) => time(m[1], m[2], m[3])],
    [/^(\d{1,2})(?::(\d{2}))?–(\d{1,2})(?::(\d{2}))?(am|pm)$/, (m) => `${m[5] === 'pm' ? '晚上' : '上午'}${m[1]}${m[2] ? ':' + m[2] : ''}–${m[3]}${m[4] ? ':' + m[4] : ''}点`],
    [/^(\d+) pts$/, (m) => `${m[1]} 分`],
    [/^(\d+)d (\d+)h$/, (m) => `${m[1]}天${+m[2]}小时`],
    [/^(\d+)h (\d+)m$/, (m) => `${m[1]}小时${+m[2]}分`],
    [/^(\d+)m (\d+)s$/, (m) => `${m[1]}分${+m[2]}秒`],
    [/^(\d+) in the draw so far$/, (m) => `目前 ${m[1]} 人参加`],
    [/^(\d+) in the draw$/, (m) => `${m[1]} 人参加`],
    [/^(\d+) at the target so far$/, (m) => `目前 ${m[1]} 人达标`],
    [/^(\d+) at the target$/, (m) => `${m[1]} 人达标`],
    [/^(.+) \+ (\d+) more$/, (m) => `${m[1]} 和另外 ${m[2]} 人`],
    [/^(\d+) winners? (?:will be|are|is) picked$/, (m) => `将抽出 ${m[1]} 位得奖者`],
    [/^(\d+) of these$/, (m) => `共 ${m[1]} 份`],
    [/^(\d+) of (\d+)$/, (m) => `${m[1]} / ${m[2]}`],
    [/^Drawn (.+)$/, (m, t) => t(m[1]) && `已开奖 ${t(m[1])}`],
    [/^Draw (.+)$/, (m, t) => t(m[1]) && `开奖 ${t(m[1])}`],
    [/^Pay before (.+) to be in the draw$/, (m, t) => t(m[1]) && `在 ${t(m[1])} 前付款即可参加`],
    // The draw time itself has a " · " in it ("Thu 5 Nov · 9:00 AM"), so the
    // line arrives here in halves.
    [/^Pay before (.+)$/, (m, t) => t(m[1]) && `在 ${t(m[1])}`],
    [/^(\d{1,2}):(\d{2}) ?(AM|PM) to be in the draw$/, (m) => `${time(m[1], m[2], m[3])} 前付款即可参加`],
    [/^Seed (\S+)$/, (m) => `种子 ${m[1]}`],
    [/^Prize (\d+)$/, (m) => `奖品 ${m[1]}`],
    [/^Reach (\d+) points in a month$/, (m) => `一个月内达到 ${m[1]} 分`],
    [/^· (.+)$/, (m, t) => t(m[1]) && `· ${t(m[1])}`],
    [/^Next session (.+)$/, (m, t) => t(m[1]) && `下一场 ${t(m[1])}`],
    [/^Games run (.+)$/, (m, t) => t(m[1]) && `球局时间 ${t(m[1])}`],
    [/^Every (.+)$/, (m) => days(m[1]) && `每逢${days(m[1])}`],
    [/^No games on (\w+)$/, (m) => days(m[1]) && `${days(m[1])}没有球局`],
    [/^Welcome back, (.+)$/, (m) => `欢迎回来，${m[1]}`],
    [/^([+-]\d+) points?$/, (m) => `${m[1]} 积分`],
    [/^(\d+) more points to enter$/, (m) => `还差 ${m[1]} 分即可参加`],
    [/^(\d+) more for the draw$/, (m) => `还差 ${m[1]} 分即可参加抽奖`],
    [/^(\d+) \/ (\d+) points this month$/, (m) => `本月 ${m[1]} / ${m[2]} 分`],
    [/^\/ (\d+) points this month$/, (m) => `/ ${m[1]} 分（本月）`],
    [/^(.+ \d{4}) draw$/, (m, t) => t(m[1]) && `${t(m[1])}抽奖`],
    [/^(\d+) nights?$/, (m) => `${m[1]} 晚`],
    [/^(\d+) games?$/, (m) => `${m[1]} 局`],
    [/^(\d+) Courts?$/, (m) => `${m[1]} 个球场`],
    [/^(\d+) Players?$/, (m) => `${m[1]} 位球员`],
    [/^Court (\S+)$/, (m) => `${m[1]} 号场`],
    [/^Game (\d+)$/, (m) => `第 ${m[1]} 局`],
    [/^Round (\d+)$/, (m) => `第 ${m[1]} 轮`],
    [/^(.+) vs (.+)$/, (m) => `${m[1]} 对 ${m[2]}`],
    [/^Skill level for (.+)$/, (m, t) => `${t(m[1]) || m[1]}的球技水平`],
    [/^(.+ \d{4}) and earlier appear here once drawn\.$/, (m, t) => t(m[1]) && `${t(m[1])}及更早的记录会在开奖后显示在这里。`],
    [/^Play a session and pay within (\d+) days? to be in the draw\. (\d+) winners? (?:is|are) picked at random at (.+?) \((.+)\)\. Payments marked after the draw time do not count\.$/,
      (m, t) => `打一场并在 ${m[1]} 天内付款即可参加抽奖。每次在${t(m[3]) || m[3]}随机抽出 ${m[2]} 位得奖者（${sched(m[4])}）。抽奖时间之后才登记的付款不算。`],
    [/^Reach (\d+) points in a month to be in that month’s draw\. (\d+) winners? (?:is|are) picked at random at (.+?) on the 1st of the following month\. Points start again from zero every month\.$/,
      (m, t) => `一个月内达到 ${m[1]} 分即可参加当月抽奖。次月 1 日${t(m[3]) || m[3]}随机抽出 ${m[2]} 位得奖者。积分每月从零开始。`],
  ];

  const MAX_DEPTH = 4;
  function tr(text, scope, depth) {
    depth = depth || 0;
    if (depth > MAX_DEPTH) return null;
    const sc = scope && SCOPED[scope];
    if (sc && Object.prototype.hasOwnProperty.call(sc, text)) return sc[text];
    if (Object.prototype.hasOwnProperty.call(ZH, text)) return ZH[text];
    const sub = s => tr(s, scope, depth + 1);
    for (const [re, fn] of PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      const out = fn(m, sub);
      if (out) return out;
    }
    // "A · B · C" and "date, status, status": translate the parts that can be,
    // keep the rest (names, amounts) as they are.
    for (const [sep, join] of [[' · ', ' · '], [', ', '，']]) {
      if (!text.includes(sep) || (sep === ', ' && /[.?!]/.test(text))) continue;
      const parts = text.split(sep);
      const outs = parts.map(sub);
      if (outs.some(o => o !== null)) return parts.map((p, i) => (outs[i] !== null ? outs[i] : p)).join(join);
    }
    return null;
  }

  // Translate keeping the surrounding whitespace; null = leave as is.
  function trSpaced(s, scope) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const core = m[2].replace(/\s+/g, ' ');
    if (!core || !/[A-Za-z]/.test(core)) return null;
    const out = tr(core, scope);
    return out === null ? null : m[1] + out + m[3];
  }

  const textMem = new WeakMap();   // text node -> { orig, shown }
  const attrMem = new WeakMap();   // element   -> { [attr]: { orig, shown } }

  function adminOpen() {
    const a = document.getElementById('admin');
    return !!(a && a.style.display && a.style.display !== 'none');
  }
  // Attributes skip less than text: a textarea's typed text is the member's,
  // but its placeholder is ours to translate.
  const ATTR_SKIP_SEL = 'script,style,code,[data-no-i18n],.lang-toggle';
  function scopeOf(el, forAttr) {
    if (!el || !el.closest || el.closest(forAttr ? ATTR_SKIP_SEL : SKIP_SEL)) return null;
    const root = el.closest(ROOT_SEL);
    if (!root) return null;
    if (root.id === 'notif' && adminOpen()) return null;
    return '#' + root.id;
  }

  function doText(node) {
    const st = textMem.get(node);
    const mine = st && node.nodeValue === st.shown;
    const orig = mine ? st.orig : node.nodeValue;
    const scope = lang === 'zh' ? scopeOf(node.parentElement) : null;
    // The lock-screen heading is one span per English word; Chinese has no
    // spaces between words, so the gaps between those spans go.
    const gap = scope && /^\s+$/.test(orig) && node.parentElement.classList.contains('gate-hero-line');
    const out = gap ? '' : (scope ? trSpaced(orig, scope) : null);
    if (out === null) {
      if (mine) node.nodeValue = st.orig;
      textMem.delete(node);
      return;
    }
    textMem.set(node, { orig, shown: out });
    if (node.nodeValue !== out) node.nodeValue = out;
  }
  function doAttrs(el) {
    let mem = attrMem.get(el);
    for (const a of ATTRS) {
      if (!el.hasAttribute(a) && !(mem && mem[a])) continue;
      const cur = el.getAttribute(a);
      const st = mem && mem[a];
      const mine = st && cur === st.shown;
      const orig = mine ? st.orig : cur;
      const scope = lang === 'zh' && orig !== null ? scopeOf(el, true) : null;
      const out = scope ? trSpaced(orig, scope) : null;
      if (out === null) {
        if (mine) el.setAttribute(a, st.orig);
        if (mem) delete mem[a];
        continue;
      }
      if (!mem) { mem = {}; attrMem.set(el, mem); }
      mem[a] = { orig, shown: out };
      if (cur !== out) el.setAttribute(a, out);
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    doAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  function walkAll() { ROOTS.forEach(sel => walk(document.querySelector(sel))); }

  let observer = null;
  function observe() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(recs => {
      if (lang !== 'zh') return;
      for (const r of recs) {
        if (r.type === 'characterData') doText(r.target);
        else if (r.type === 'attributes') doAttrs(r.target);
        else r.addedNodes.forEach(walk);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function paintToggles() {
    document.querySelectorAll('.lang-toggle button[data-lang]').forEach(b => {
      const on = b.dataset.lang === lang;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function apply() {
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    walkAll();
    paintToggles();
  }
  function set(next) {
    lang = next === 'zh' ? 'zh' : 'en';
    try { localStorage.setItem(KEY, lang); } catch (e) {}
    apply();
  }

  function start() {
    observe();
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.I18N = { set, lang: () => lang, t: (s) => (lang === 'zh' ? (tr(s) ?? s) : s), _tr: tr };
})();
