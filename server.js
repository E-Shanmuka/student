// server.js
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const multer = require('multer');
const { Op } = require('sequelize');

const sequelize = require('./db');
const User = require('./models/user.js');
const Blog = require('./models/blog.js');
const BlogComment = require('./models/blogcomment.js');
const BlogLike = require('./models/bloglike.js');
const PrivateChat = require('./models/privatechat.js');
const Group = require('./models/group.js');
const GroupChat = require('./models/groupchat.js');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'secret-key',
  resave: false,
  saveUninitialized: true
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if(req.session && req.session.user) next();
  else res.redirect('/');
}

app.get('/', (req, res) => {
  if(req.session.user) return res.redirect('/home.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/register.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'register.html')); });
app.post('/register.html', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const existing = await User.findOne({ where: { username } });
    if(existing) return res.send("Username already exists.");
    const newUser = await User.create({ username, email, password });
    req.session.user = { id: newUser.id, username: newUser.username, email: newUser.email };
    res.redirect('/home.html');
  } catch(err) { console.error(err); res.send("Registration error."); }
});
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ where: { username, password } });
    if(user) { req.session.user = { id: user.id, username: user.username, email: user.email }; res.redirect('/home.html'); }
    else res.send("Invalid credentials.");
  } catch(err) { console.error(err); res.send("Login error."); }
});
app.get('/home.html', requireAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'home.html')); });
app.get('/friend.html', requireAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'friend.html')); });
app.get('/group.html', requireAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'group.html')); });
app.get('/admin.html', requireAuth, async (req, res) => {
  if(req.session.user.username !== 'admin') return res.send("Access denied. (Admin: username=admin, password=000)");
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// API endpoints for admin management and chat retrieval...
app.get('/api/users', requireAuth, async (req, res) => { const users = await User.findAll(); res.json(users); });
app.delete('/api/users/:id', requireAuth, async (req, res) => {
  try { await User.destroy({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/blogs', requireAuth, async (req, res) => { const blogs = await Blog.findAll({ order: [['id', 'DESC']] }); res.json(blogs); });
app.delete('/api/blogs/:id', requireAuth, async (req, res) => {
  try { await Blog.destroy({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/groups', requireAuth, async (req, res) => { const groups = await Group.findAll({ order: [['id', 'DESC']] }); res.json(groups); });
app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  try { await Group.destroy({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/blogcomments', requireAuth, async (req, res) => {
  const blogId = req.query.blogId;
  try { const comments = await BlogComment.findAll({ where: { blogId }, order: [['createdAt', 'ASC']] }); res.json(comments); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/privatechats', requireAuth, async (req, res) => {
  const { user1, user2 } = req.query;
  try {
    const chats = await PrivateChat.findAll({
      where: { [Op.or]: [ { sender: user1, receiver: user2 }, { sender: user2, receiver: user1 } ] },
      order: [['createdAt', 'ASC']]
    });
    res.json(chats);
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/groupchats', requireAuth, async (req, res) => {
  const { groupId } = req.query;
  try {
    const chats = await GroupChat.findAll({ where: { groupId }, order: [['createdAt', 'ASC']] });
    res.json(chats);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// File upload endpoint for blog images
const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, 'public/uploads/'); },
  filename: (req, file, cb) => { cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage });
app.post('/upload', upload.single('blogImage'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});
app.get('/search/users', requireAuth, async (req, res) => {
  const q = req.query.q;
  try { const results = await User.findAll({ where: { username: { [Op.like]: `%${q}%` } } }); res.json(results); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// Socket.IO events
const onlineUsers = {};
io.on('connection', (socket) => {
  console.log("Socket connected: " + socket.id);
  socket.on('register user', (data) => { onlineUsers[data.username] = socket.id; });
  socket.on('disconnect', () => {
    for(const [username, id] of Object.entries(onlineUsers)) {
      if(id === socket.id) { delete onlineUsers[username]; break; }
    }
    console.log("Socket disconnected: " + socket.id);
  });
  
  // Private chat
  socket.on('private message', async (data) => {
    await PrivateChat.create({ sender: data.from, receiver: data.to, message: data.message });
    const targetSocket = onlineUsers[data.to];
    if(targetSocket) io.to(targetSocket).emit('private message', data);
    socket.emit('private message', data);
  });
  
  // Group chat
  socket.on('group message', async (data) => {
    await GroupChat.create({ groupId: data.groupId, username: data.username, message: data.message });
    io.emit('group message', data);
  });
  
  // Blog creation
  socket.on('create blog', async (data) => {
    const newBlog = await Blog.create({ username: data.username, content: data.content, image: data.image });
    io.emit('new blog', newBlog);
  });
  
  // Blog like toggle
  socket.on('blog like', async (data) => {
    const existing = await BlogLike.findOne({ where: { blogId: data.blogId, username: data.username } });
    if(existing) { await existing.destroy(); } else { await BlogLike.create({ blogId: data.blogId, username: data.username }); }
    const count = await BlogLike.count({ where: { blogId: data.blogId } });
    const blog = await Blog.findByPk(data.blogId);
    blog.likes = count;
    await blog.save();
    io.emit('blog updated', blog);
  });
  
  // Blog comment
  socket.on('blog comment', async (data) => {
    await BlogComment.create({ blogId: data.blogId, username: data.username, comment: data.comment });
    io.emit('blog comment', data);
  });
  
  // Create group event handler
  socket.on('create group', async (data) => {
    try {
      const newGroup = await Group.create({ groupName: data.groupName, createdBy: data.createdBy });
      io.emit('new group', newGroup);
    } catch (err) {
      console.error("Error creating group:", err);
    }
  });
  
  // Whiteboard drawing
  socket.on('whiteboard draw', (data) => { socket.broadcast.emit('whiteboard draw', data); });
  
  // Screen share (placeholder)
  socket.on('screen share', (data) => { io.emit('screen share', data); });
  
  // Mic toggle
  socket.on('mic toggle', (data) => { io.emit('mic toggle', data); });
});

sequelize.sync({force: true}).then(async () => {
  // Create admin user if not exists
  const adminExists = await User.findOne({ where: { username: 'admin' } });
  if(!adminExists) {
    await User.create({ username: 'admin', email: 'admin@example.com', password: '000' });
    console.log("Admin user created: admin/000");
  }
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => console.error("DB sync error:", err));
